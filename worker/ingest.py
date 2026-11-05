import io
import hashlib
import logging
from pathlib import Path
from docx import Document
from pypdf import PdfReader
from app.aws import client, embed
from app.vector import upsert
from app.config import settings
from app.db import connection, audit
from app.observability import trace, initialize

initialize()

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('atlas.worker')


def parse(blob: bytes, suffix: str):
    if suffix == '.pdf':
        reader = PdfReader(io.BytesIO(blob))
        pages = []
        for i, page in enumerate(reader.pages):
            try:
                txt = page.extract_text() or ''
            except Exception as e:
                log.warning('Failed to extract text from page %d: %s', i + 1, e)
                txt = ''
            pages.append((i + 1, txt))
        return pages
    if suffix == '.docx':
        doc = Document(io.BytesIO(blob))
        return [(1, '\n'.join(p.text for p in doc.paragraphs))]
    return [(1, blob.decode('utf-8', errors='replace'))]


def chunks(text, size=1200, overlap=180):
    text = ' '.join(text.split())
    pos = 0
    while pos < len(text):
        yield text[pos:pos + size]
        if pos + size >= len(text):
            break
        pos += size - overlap


@trace("process_s3_key")
def process_s3_key(key):
    s = settings()
    with connection() as conn:
        doc = conn.execute('SELECT * FROM documents WHERE s3_key=%s FOR UPDATE', (key,)).fetchone()
        if not doc or doc['status'] == 'ready':
            return
        if doc['status'] not in ('queued', 'pending', 'failed'):
            # Already processing by another worker/thread
            return
        conn.execute("UPDATE documents SET status='processing', updated_at=now(), error_message=NULL WHERE id=%s", (doc['id'],))

    try:
        obj = client('s3').get_object(Bucket=s.s3_bucket, Key=key)
        if obj['ContentLength'] > s.max_upload_bytes:
            raise ValueError(f'Upload too large: {obj["ContentLength"]} bytes exceeds maximum {s.max_upload_bytes}')
        blob = obj['Body'].read(s.max_upload_bytes + 1)
        if len(blob) > s.max_upload_bytes:
            raise ValueError(f'Upload too large: exceeds maximum {s.max_upload_bytes} bytes')

        computed_hash = hashlib.sha256(blob).hexdigest()
        with connection() as conn:
            conn.execute("UPDATE documents SET checksum_sha256=%s WHERE id=%s", (computed_hash, doc['id']))

        suffix = Path(key).suffix.lower()
        if suffix == '.pdf' and not blob.startswith(b'%PDF'):
            raise ValueError('Invalid PDF format: file content does not start with %PDF header')

        pages = parse(blob, suffix)
        parts = [(page, part) for page, text in pages for part in chunks(text)]
        if not parts:
            raise ValueError('No extractable text found; scanned PDFs or empty documents cannot be indexed')

        # Check if another document in the same tenant with the same checksum is already ready.
        # If so, vectors are already in Pinecone for this tenant.
        with connection() as conn:
            existing_ready = conn.execute(
                """SELECT id FROM documents 
                   WHERE tenant_id=%s AND checksum_sha256=%s AND status='ready' AND id != %s
                   LIMIT 1""",
                (doc['tenant_id'], computed_hash, doc['id'])
            ).fetchone()

        if not existing_ready:
            vectors = []
            for i, (page, part) in enumerate(parts):
                vectors.append({
                    'id': f'{doc["id"]}:{doc["current_version"]}:{i}',
                    'values': embed(part),
                    'metadata': {
                        'document_id': str(doc['id']),
                        'title': doc['title'],
                        'page': page,
                        'text': part,
                        'owner_sub': doc['owner_sub'],
                        'allowed_groups': doc['allowed_groups']
                    }
                })
            # Keep batches small; Pinecone metadata must fit the index's limits.
            for i in range(0, len(vectors), 50):
                upsert(doc['tenant_id'], vectors[i:i + 50])

        with connection() as conn:
            conn.execute(
                "UPDATE documents SET status='ready', error_message=NULL, updated_at=now() WHERE id=%s",
                (doc['id'],)
            )
            audit(conn, doc['owner_sub'], doc['tenant_id'], 'ingest_ready', {
                'document_id': str(doc['id']),
                'chunks': len(parts),
                'checksum': computed_hash
            })
        log.info('Ingested document %s chunks=%d', doc['id'], len(parts))

    except Exception as exc:
        err_msg = str(exc) or type(exc).__name__
        log.exception('Ingestion failed for key %s: %s', key, err_msg)
        with connection() as conn:
            conn.execute(
                "UPDATE documents SET status='failed', error_message=%s, updated_at=now() WHERE id=%s",
                (err_msg, doc['id'])
            )
            audit(conn, doc['owner_sub'], doc['tenant_id'], 'ingest_failed', {
                'document_id': str(doc['id']),
                'error': err_msg
            })
        raise
