import re
import uuid
from pathlib import Path
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from app.observability import initialize
from app.demo_context import principal, Principal
from app.aws import client
from app.config import settings
from app.db import connection, audit
from app.rag import chat
from app.guardrails import check_input, classify_input
from app.memory import history, save_turn, list_messages
from worker.ingest import process_s3_key

initialize()


BASE = Path(__file__).resolve().parent
app = FastAPI(title='Atlas Enterprise RAG', docs_url='/api/docs')
app.mount('/static', StaticFiles(directory=BASE / 'static'), name='static')
templates = Jinja2Templates(directory=BASE / 'templates')


class Upload(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    checksum_sha256: str = Field(default="", max_length=64)


class CompleteUpload(BaseModel):
    document_id: uuid.UUID


class Ask(BaseModel):
    question: str = Field(min_length=3, max_length=2000)
    conversation_id: uuid.UUID | None = None


class Feedback(BaseModel):
    document_id: str | None = None
    rating: int = Field(ge=-1, le=1)
    note: str = Field(default='', max_length=500)


class ApprovalDecision(BaseModel):
    approve: bool


@app.get('/', response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse('index.html', {
        'request': request,
        'region': settings().aws_region,
        'mode': 'single-workspace demo'
    })


@app.get('/health/live')
def live():
    return {'status': 'alive'}


@app.get('/health/ready')
def ready():
    try:
        with connection() as conn:
            conn.execute('SELECT 1').fetchone()
        return {'status': 'ready'}
    except Exception as exc:
        raise HTTPException(503, 'Database unavailable') from exc


@app.post('/api/documents/uploads')
def create_upload(body: Upload, p: Principal = Depends(principal)):
    suffix = Path(body.filename).suffix.lower()
    if suffix not in {'.pdf', '.docx', '.txt', '.md'}:
        raise HTTPException(400, 'Allowed types: PDF, DOCX, TXT, MD')

    checksum = body.checksum_sha256.strip().lower()
    if checksum and not re.fullmatch(r'^[a-f0-9]{64}$', checksum):
        raise HTTPException(400, 'Invalid checksum_sha256 format')

    with connection() as conn:
        # If checksum is provided, use an advisory lock on the tenant and hash
        # to ensure concurrent uploads of the same file serialize safely.
        if checksum:
            conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{p.tenant}:{checksum}",))
            existing = conn.execute(
                """SELECT id, title, s3_key, status, current_version, error_message
                   FROM documents
                   WHERE tenant_id=%s AND checksum_sha256=%s AND status != 'retired'
                   ORDER BY created_at DESC LIMIT 1""",
                (p.tenant, checksum)
            ).fetchone()

            if existing:
                status = existing['status']
                if status == 'ready':
                    return {
                        'document_id': str(existing['id']),
                        'status': 'ready',
                        'message': 'Document already exists and is ready.',
                        'already_exists': True
                    }
                elif status in ('queued', 'pending', 'processing'):
                    return {
                        'document_id': str(existing['id']),
                        'status': status,
                        'message': f'Document is already {status}.',
                        'already_exists': True
                    }
                elif status == 'failed':
                    # Reuse existing record, reset to queued and clear error
                    conn.execute(
                        "UPDATE documents SET status='queued', error_message=NULL, updated_at=now() WHERE id=%s",
                        (existing['id'],)
                    )
                    audit(conn, p.subject, p.tenant, 'upload_retry_requested', {'document_id': str(existing['id'])})
                    url = client('s3').generate_presigned_url(
                        'put_object',
                        Params={'Bucket': settings().s3_bucket, 'Key': existing['s3_key'], 'ContentType': 'application/octet-stream'},
                        ExpiresIn=300
                    )
                    return {
                        'document_id': str(existing['id']),
                        'upload_url': url,
                        'headers': {'Content-Type': 'application/octet-stream'},
                        'status': 'queued',
                        'already_exists': False
                    }

        doc_id = str(uuid.uuid4())
        key = f'tenants/{p.tenant}/incoming/{doc_id}/v1{suffix}'
        conn.execute(
            """INSERT INTO documents(id, tenant_id, title, owner_sub, allowed_groups, s3_key, status, current_version, checksum_sha256)
               VALUES (%s, %s, %s, %s, %s, %s, 'queued', 1, %s)""",
            (doc_id, p.tenant, body.filename, p.subject, ["workspace"], key, checksum or None)
        )
        audit(conn, p.subject, p.tenant, 'upload_requested', {'document_id': doc_id, 'checksum': checksum or None})

    url = client('s3').generate_presigned_url(
        'put_object',
        Params={'Bucket': settings().s3_bucket, 'Key': key, 'ContentType': 'application/octet-stream'},
        ExpiresIn=300
    )
    return {
        'document_id': doc_id,
        'upload_url': url,
        'headers': {'Content-Type': 'application/octet-stream'},
        'status': 'queued',
        'already_exists': False
    }


@app.post('/api/documents/complete')
def complete_upload(body: CompleteUpload, p: Principal = Depends(principal)):
    with connection() as conn:
        row = conn.execute(
            """SELECT id, s3_key, status, error_message FROM documents WHERE id=%s AND tenant_id=%s""",
            (body.document_id, p.tenant)
        ).fetchone()
    if not row:
        raise HTTPException(404, 'Document not found')
    if row['status'] == 'ready':
        return {'status': 'ready', 'document_id': str(body.document_id)}
    if row['status'] == 'processing':
        return {'status': 'processing', 'document_id': str(body.document_id)}

    try:
        process_s3_key(row['s3_key'])
    except Exception as exc:
        with connection() as conn:
            err_row = conn.execute("SELECT error_message FROM documents WHERE id=%s", (row['id'],)).fetchone()
        err_msg = (err_row and err_row['error_message']) or str(exc)
        raise HTTPException(502, f'Ingestion failed: {err_msg}') from exc
    return {'status': 'ready', 'document_id': str(body.document_id)}


@app.post('/api/documents/{document_id}/retry')
def retry_document(document_id: uuid.UUID, p: Principal = Depends(principal)):
    with connection() as conn:
        doc = conn.execute(
            "SELECT id, s3_key, status, title FROM documents WHERE id=%s AND tenant_id=%s",
            (document_id, p.tenant)
        ).fetchone()
        if not doc:
            raise HTTPException(404, 'Document not found')
        if doc['status'] == 'ready':
            return {'status': 'ready', 'message': 'Document is already ready'}
        if doc['status'] == 'processing':
            return {'status': 'processing', 'message': 'Document is currently being processed'}

        conn.execute(
            "UPDATE documents SET status='queued', error_message=NULL, updated_at=now() WHERE id=%s",
            (doc['id'],)
        )
        audit(conn, p.subject, p.tenant, 'document_retry_requested', {'document_id': str(doc['id'])})

    try:
        process_s3_key(doc['s3_key'])
    except Exception as exc:
        with connection() as conn:
            err_row = conn.execute("SELECT error_message FROM documents WHERE id=%s", (doc['id'],)).fetchone()
        err_msg = (err_row and err_row['error_message']) or str(exc)
        raise HTTPException(502, f'Ingestion retry failed: {err_msg}') from exc
    return {'status': 'ready', 'document_id': str(doc['id'])}


@app.get('/api/documents')
def documents(p: Principal = Depends(principal)):
    with connection() as conn:
        rows = conn.execute(
            '''SELECT id, title, status, current_version, checksum_sha256, error_message, created_at, updated_at, allowed_groups
               FROM documents
               WHERE tenant_id=%s AND (allowed_groups && %s::text[] OR owner_sub=%s)
               ORDER BY created_at DESC LIMIT 100''',
            (p.tenant, list(p.groups), p.subject)
        ).fetchall()
    return {'documents': rows}


@app.post('/api/chat')
def ask(body: Ask, p: Principal = Depends(principal)):
    reason = classify_input(body.question)
    if reason:
        with connection() as conn:
            audit(conn, p.subject, p.tenant, 'guardrail_input_blocked', {'reason': reason})
        raise HTTPException(400, f'Input guardrail blocked this request ({reason}).')
    if settings().hitl_enabled and any(x in body.question.lower() for x in ('delete', 'export', 'send to', 'update policy')):
        with connection() as conn:
            row = conn.execute(
                'INSERT INTO approvals(tenant_id,requester,question,status) VALUES (%s,%s,%s,%s) RETURNING id',
                (p.tenant, p.subject, body.question, 'pending')
            ).fetchone()
            audit(conn, p.subject, p.tenant, 'approval_requested', {'id': str(row['id'])})
        return {
            'answer': 'This request requires administrator approval before any action. Open the Approvals tab to review it.',
            'sources': [],
            'status': 'pending_approval',
            'approval_id': str(row['id'])
        }
    conversation_id = body.conversation_id or uuid.uuid4()
    prior = history(p.tenant, conversation_id)
    result = chat(p, body.question, prior)
    save_turn(p.tenant, conversation_id, body.question, result['answer'])
    if result.get('answer') == 'The response was blocked by the sensitive-data output guardrail.':
        with connection() as conn:
            audit(conn, p.subject, p.tenant, 'guardrail_output_blocked', {'conversation_id': str(conversation_id)})
        result['status'] = 'guardrail_blocked'
        result['sources'] = []
    return {**result, 'conversation_id': str(conversation_id)}


@app.get('/api/conversations/{conversation_id}/messages')
def conversation_messages(conversation_id: uuid.UUID, p: Principal = Depends(principal)):
    return {'conversation_id': str(conversation_id), 'messages': list_messages(p.tenant, conversation_id)}


@app.post('/api/feedback')
def feedback(body: Feedback, p: Principal = Depends(principal)):
    with connection() as conn:
        conn.execute(
            'INSERT INTO feedback(tenant_id,actor,rating,note) VALUES (%s,%s,%s,%s)',
            (p.tenant, p.subject, body.rating, body.note)
        )
    return {'saved': True}


@app.get('/api/admin/metrics')
def metrics(p: Principal = Depends(principal)):
    with connection() as conn:
        docs = conn.execute('SELECT status,count(*) AS total FROM documents WHERE tenant_id=%s GROUP BY status', (p.tenant,)).fetchall()
        fb = conn.execute('SELECT rating,count(*) AS total FROM feedback WHERE tenant_id=%s GROUP BY rating', (p.tenant,)).fetchall()
    return {'documents': docs, 'feedback': fb}


@app.get('/api/approvals')
def list_approvals(p: Principal = Depends(principal)):
    if not p.admin:
        raise HTTPException(403, 'Admin only')
    with connection() as conn:
        rows = conn.execute(
            "SELECT id,requester,question,status,reviewer,created_at,reviewed_at FROM approvals WHERE tenant_id=%s ORDER BY created_at DESC LIMIT 100",
            (p.tenant,)
        ).fetchall()
    return {'approvals': rows}


@app.post('/api/approvals/{approval_id}/decision')
def decide(approval_id: uuid.UUID, body: ApprovalDecision, p: Principal = Depends(principal)):
    if not p.admin:
        raise HTTPException(403, 'Admin only')
    with connection() as conn:
        row = conn.execute(
            "UPDATE approvals SET status=%s,reviewer=%s,reviewed_at=now() WHERE id=%s AND tenant_id=%s AND status='pending' RETURNING id",
            ('approved' if body.approve else 'rejected', p.subject, approval_id, p.tenant)
        ).fetchone()
        if not row:
            raise HTTPException(404, 'Pending approval not found')
        audit(conn, p.subject, p.tenant, 'approval_decided', {'id': str(approval_id), 'approved': body.approve})
    # Approval is a decision record only; it never automatically executes a destructive action.
    return {'status': 'approved' if body.approve else 'rejected', 'executed': False}


@app.get('/api/admin/guardrails')
def guardrail_metrics(p: Principal = Depends(principal)):
    if not p.admin:
        raise HTTPException(403, 'Admin only')
    with connection() as conn:
        rows = conn.execute(
            """SELECT action,count(*) AS total FROM audit_events
            WHERE tenant_id=%s AND action IN ('guardrail_input_blocked','guardrail_output_blocked')
            GROUP BY action ORDER BY action""",
            (p.tenant,)
        ).fetchall()
    return {'events': rows, 'mode': 'deterministic_demo', 'managed_bedrock_guardrails': False}
