import sys
import uuid
import hashlib
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

# Ensure project root is on sys.path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.main import app
from app.demo_context import Principal, principal
from app.db import connection


def make_pdf(text: str) -> bytes:
    content = f"BT /F1 12 Tf 50 700 Td ({text}) Tj ET".encode('latin1')
    stream_len = len(content)
    pdf = f"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length {stream_len} >>
stream
{content.decode('latin1')}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000300 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
380
%%EOF"""
    return pdf.encode('latin1')


class TestUploadIngestionPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        # Unique test tenant to completely isolate test records from production data
        cls.test_tenant = f"test-tenant-{uuid.uuid4().hex[:8]}"
        app.dependency_overrides[principal] = lambda: Principal(
            subject="test-operator",
            tenant=cls.test_tenant,
            groups=("workspace",),
            admin=True
        )

    @classmethod
    def tearDownClass(cls):
        app.dependency_overrides.clear()
        # Clean up only this test tenant's records
        try:
            with connection() as conn:
                conn.execute("DELETE FROM documents WHERE tenant_id=%s", (cls.test_tenant,))
                conn.execute("DELETE FROM audit_events WHERE tenant_id=%s", (cls.test_tenant,))
        except Exception:
            pass

    def _mock_s3_and_embed(self, pdf_store):
        """Helper to mock S3 get_object, Bedrock embed, and Pinecone upsert."""
        def fake_get_object(Bucket, Key):
            if Key not in pdf_store:
                raise RuntimeError(f"S3 Key {Key} not found in mock store")
            blob = pdf_store[Key]
            import io
            return {
                'ContentLength': len(blob),
                'Body': io.BytesIO(blob)
            }

        s3_mock = MagicMock()
        s3_mock.get_object.side_effect = fake_get_object
        s3_mock.generate_presigned_url.return_value = "https://mock-s3.amazonaws.com/put"

        patch_client = patch('worker.ingest.client', return_value=s3_mock)
        patch_embed = patch('worker.ingest.embed', return_value=[0.01] * 1024)
        patch_upsert = patch('worker.ingest.upsert', return_value=None)
        return patch_client, patch_embed, patch_upsert

    def test_01_upload_new_pdf_once(self):
        """Case 1: Upload a new PDF once -> Exactly 1 document record, queued -> ready lifecycle."""
        pdf_bytes = make_pdf("Atlas Policy Document V1 - Clean Upload")
        checksum = hashlib.sha256(pdf_bytes).hexdigest()
        filename = "test_policy_v1.pdf"

        # Step 1: Upload request
        res = self.client.post("/api/documents/uploads", json={
            "filename": filename,
            "checksum_sha256": checksum
        })
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        doc_id = data["document_id"]
        self.assertEqual(data["status"], "queued")
        self.assertFalse(data["already_exists"])
        self.assertIn("upload_url", data)

        # Check DB state after upload request
        with connection() as conn:
            docs = conn.execute(
                "SELECT id, status, checksum_sha256, title, s3_key FROM documents WHERE tenant_id=%s AND checksum_sha256=%s",
                (self.test_tenant, checksum)
            ).fetchall()
            self.assertEqual(len(docs), 1, "Exactly one document record must exist")
            self.assertEqual(docs[0]["status"], "queued")
            s3_key = docs[0]["s3_key"]

        # Step 2: Complete upload and trigger ingestion
        pdf_store = {s3_key: pdf_bytes}
        patch_client, patch_embed, patch_upsert = self._mock_s3_and_embed(pdf_store)
        with patch_client, patch_embed, patch_upsert:
            complete_res = self.client.post("/api/documents/complete", json={"document_id": doc_id})
            self.assertEqual(complete_res.status_code, 200, complete_res.text)
            self.assertEqual(complete_res.json()["status"], "ready")

        # Check DB state after ingestion
        with connection() as conn:
            docs = conn.execute(
                "SELECT id, status, error_message FROM documents WHERE id=%s",
                (doc_id,)
            ).fetchall()
            self.assertEqual(len(docs), 1)
            self.assertEqual(docs[0]["status"], "ready")
            self.assertIsNone(docs[0]["error_message"])

        print("[PASS] Case 1: Upload a new PDF once verified (status: queued -> ready, 1 record)")

    def test_02_upload_same_pdf_twice(self):
        """Case 2: Upload the same PDF twice -> Idempotent, prevents duplicate records."""
        pdf_bytes = make_pdf("Duplicate Check Document")
        checksum = hashlib.sha256(pdf_bytes).hexdigest()
        filename = "duplicate_check.pdf"

        # First upload
        res1 = self.client.post("/api/documents/uploads", json={"filename": filename, "checksum_sha256": checksum})
        self.assertEqual(res1.status_code, 200)
        doc1_id = res1.json()["document_id"]

        with connection() as conn:
            row = conn.execute("SELECT s3_key FROM documents WHERE id=%s", (doc1_id,)).fetchone()
            s3_key = row["s3_key"]

        # Complete ingestion for doc 1
        pdf_store = {s3_key: pdf_bytes}
        p_c, p_e, p_u = self._mock_s3_and_embed(pdf_store)
        with p_c, p_e, p_u:
            comp = self.client.post("/api/documents/complete", json={"document_id": doc1_id})
            self.assertEqual(comp.status_code, 200)
            self.assertEqual(comp.json()["status"], "ready")

        # Second upload of the EXACT same PDF
        res2 = self.client.post("/api/documents/uploads", json={"filename": filename, "checksum_sha256": checksum})
        self.assertEqual(res2.status_code, 200)
        data2 = res2.json()

        # Must return the existing document ID and status ready, without creating a new record
        self.assertEqual(data2["document_id"], doc1_id)
        self.assertEqual(data2["status"], "ready")
        self.assertTrue(data2["already_exists"])

        # Check DB: Still exactly 1 record for this checksum
        with connection() as conn:
            count = conn.execute(
                "SELECT count(*) as c FROM documents WHERE tenant_id=%s AND checksum_sha256=%s",
                (self.test_tenant, checksum)
            ).fetchone()["c"]
            self.assertEqual(count, 1, f"Expected 1 record, found {count}")

        print("[PASS] Case 2: Upload same PDF twice verified (idempotent, 1 record preserved)")

    def test_03_upload_two_different_pdfs(self):
        """Case 3: Upload two different PDFs -> Creates two separate documents."""
        pdf_a = make_pdf("Distinct Document A Content")
        pdf_b = make_pdf("Distinct Document B Content - Completely Different")
        hash_a = hashlib.sha256(pdf_a).hexdigest()
        hash_b = hashlib.sha256(pdf_b).hexdigest()
        self.assertNotEqual(hash_a, hash_b)

        # Upload Document A
        res_a = self.client.post("/api/documents/uploads", json={"filename": "doc_a.pdf", "checksum_sha256": hash_a})
        self.assertEqual(res_a.status_code, 200)
        id_a = res_a.json()["document_id"]

        # Upload Document B
        res_b = self.client.post("/api/documents/uploads", json={"filename": "doc_b.pdf", "checksum_sha256": hash_b})
        self.assertEqual(res_b.status_code, 200)
        id_b = res_b.json()["document_id"]

        self.assertNotEqual(id_a, id_b, "Different files must have different IDs")

        # Ingest both
        with connection() as conn:
            key_a = conn.execute("SELECT s3_key FROM documents WHERE id=%s", (id_a,)).fetchone()["s3_key"]
            key_b = conn.execute("SELECT s3_key FROM documents WHERE id=%s", (id_b,)).fetchone()["s3_key"]

        pdf_store = {key_a: pdf_a, key_b: pdf_b}
        p_c, p_e, p_u = self._mock_s3_and_embed(pdf_store)
        with p_c, p_e, p_u:
            self.assertEqual(self.client.post("/api/documents/complete", json={"document_id": id_a}).status_code, 200)
            self.assertEqual(self.client.post("/api/documents/complete", json={"document_id": id_b}).status_code, 200)

        with connection() as conn:
            docs = conn.execute(
                "SELECT id, status FROM documents WHERE id IN (%s, %s)",
                (id_a, id_b)
            ).fetchall()
            self.assertEqual(len(docs), 2)
            for d in docs:
                self.assertEqual(d["status"], "ready")

        print("[PASS] Case 3: Upload two different PDFs verified (two separate records, both ready)")

    def test_04_simulate_pdf_parsing_failure(self):
        """Case 4: Simulate PDF parsing failure -> Marks status failed with error message, single record."""
        # Corrupted PDF blob: starts with %PDF header but corrupted contents
        corrupted_blob = b"%PDF-1.4 Corrupted content without proper objects"
        checksum = hashlib.sha256(corrupted_blob).hexdigest()

        res = self.client.post("/api/documents/uploads", json={"filename": "corrupted.pdf", "checksum_sha256": checksum})
        self.assertEqual(res.status_code, 200)
        doc_id = res.json()["document_id"]

        with connection() as conn:
            s3_key = conn.execute("SELECT s3_key FROM documents WHERE id=%s", (doc_id,)).fetchone()["s3_key"]

        pdf_store = {s3_key: corrupted_blob}
        p_c, p_e, p_u = self._mock_s3_and_embed(pdf_store)
        with p_c, p_e, p_u:
            comp = self.client.post("/api/documents/complete", json={"document_id": doc_id})
            # Expected 502 with error details
            self.assertEqual(comp.status_code, 502)

        with connection() as conn:
            doc = conn.execute("SELECT id, status, error_message FROM documents WHERE id=%s", (doc_id,)).fetchone()
            self.assertEqual(doc["status"], "failed")
            self.assertIsNotNone(doc["error_message"])
            self.assertTrue(len(doc["error_message"]) > 0)

            # Assert only 1 document record exists
            count = conn.execute("SELECT count(*) as c FROM documents WHERE checksum_sha256=%s", (checksum,)).fetchone()["c"]
            self.assertEqual(count, 1)

        print(f"[PASS] Case 4: Simulate PDF parsing failure verified (status: failed, reason: {doc['error_message'][:40]}...)")

    def test_05_simulate_embedding_failure(self):
        """Case 5: Simulate Bedrock embedding failure -> Marks status failed with error message, single record."""
        pdf_bytes = make_pdf("Valid PDF for Embed Failure Test")
        checksum = hashlib.sha256(pdf_bytes).hexdigest()

        res = self.client.post("/api/documents/uploads", json={"filename": "embed_fail.pdf", "checksum_sha256": checksum})
        self.assertEqual(res.status_code, 200)
        doc_id = res.json()["document_id"]

        with connection() as conn:
            s3_key = conn.execute("SELECT s3_key FROM documents WHERE id=%s", (doc_id,)).fetchone()["s3_key"]

        pdf_store = {s3_key: pdf_bytes}
        fake_s3 = MagicMock()
        import io
        fake_s3.get_object.return_value = {'ContentLength': len(pdf_bytes), 'Body': io.BytesIO(pdf_bytes)}

        # Mock embed raising a ThrottlingException
        with patch('worker.ingest.client', return_value=fake_s3), \
             patch('worker.ingest.embed', side_effect=RuntimeError("ThrottlingException: Bedrock rate limit exceeded")):
            comp = self.client.post("/api/documents/complete", json={"document_id": doc_id})
            self.assertEqual(comp.status_code, 502)

        with connection() as conn:
            doc = conn.execute("SELECT id, status, error_message FROM documents WHERE id=%s", (doc_id,)).fetchone()
            self.assertEqual(doc["status"], "failed")
            self.assertIn("Bedrock rate limit exceeded", doc["error_message"])

            # Exactly 1 record
            count = conn.execute("SELECT count(*) as c FROM documents WHERE checksum_sha256=%s", (checksum,)).fetchone()["c"]
            self.assertEqual(count, 1)

        print("[PASS] Case 5: Simulate embedding failure verified (status: failed, reason recorded, 1 record)")

    def test_06_retry_failed_document(self):
        """Case 6: Retry a failed document -> Ingestion succeeds, status ready, same document record."""
        pdf_bytes = make_pdf("Retryable Document Content")
        checksum = hashlib.sha256(pdf_bytes).hexdigest()

        # First trigger a failure
        res = self.client.post("/api/documents/uploads", json={"filename": "retry_doc.pdf", "checksum_sha256": checksum})
        doc_id = res.json()["document_id"]

        with connection() as conn:
            s3_key = conn.execute("SELECT s3_key FROM documents WHERE id=%s", (doc_id,)).fetchone()["s3_key"]

        pdf_store = {s3_key: pdf_bytes}
        fake_s3 = MagicMock()
        import io
        fake_s3.get_object.return_value = {'ContentLength': len(pdf_bytes), 'Body': io.BytesIO(pdf_bytes)}

        # Simulate failure
        with patch('worker.ingest.client', return_value=fake_s3), \
             patch('worker.ingest.embed', side_effect=RuntimeError("Transient network failure")):
            self.client.post("/api/documents/complete", json={"document_id": doc_id})

        with connection() as conn:
            self.assertEqual(conn.execute("SELECT status FROM documents WHERE id=%s", (doc_id,)).fetchone()["status"], "failed")

        # Now call the Retry endpoint
        p_c, p_e, p_u = self._mock_s3_and_embed(pdf_store)
        with p_c, p_e, p_u:
            retry_res = self.client.post(f"/api/documents/{doc_id}/retry")
            self.assertEqual(retry_res.status_code, 200, retry_res.text)
            self.assertEqual(retry_res.json()["status"], "ready")

        with connection() as conn:
            doc = conn.execute("SELECT id, status, error_message FROM documents WHERE id=%s", (doc_id,)).fetchone()
            self.assertEqual(doc["status"], "ready")
            self.assertIsNone(doc["error_message"])

            # Verify no duplicate document was created
            count = conn.execute("SELECT count(*) as c FROM documents WHERE checksum_sha256=%s", (checksum,)).fetchone()["c"]
            self.assertEqual(count, 1)

        print("[PASS] Case 6: Retry a failed document verified (transitions failed -> ready, no new record)")

    def test_07_concurrent_upload_requests(self):
        """Case 7: Trigger two concurrent upload requests -> Advisory lock prevents duplicate records."""
        import concurrent.futures
        pdf_bytes = make_pdf("Concurrent Race Test Document")
        checksum = hashlib.sha256(pdf_bytes).hexdigest()
        filename = "concurrent_race.pdf"

        def do_upload():
            # Dedicated client per thread
            c = TestClient(app)
            return c.post("/api/documents/uploads", json={"filename": filename, "checksum_sha256": checksum})

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            fut1 = executor.submit(do_upload)
            fut2 = executor.submit(do_upload)
            res1 = fut1.result()
            res2 = fut2.result()

        self.assertEqual(res1.status_code, 200)
        self.assertEqual(res2.status_code, 200)

        id1 = res1.json()["document_id"]
        id2 = res2.json()["document_id"]
        # Both requests must refer to the exact same document record!
        self.assertEqual(id1, id2, "Concurrent requests for the same file must return the same document ID")

        # Exactly 1 record in DB
        with connection() as conn:
            count = conn.execute(
                "SELECT count(*) as c FROM documents WHERE tenant_id=%s AND checksum_sha256=%s",
                (self.test_tenant, checksum)
            ).fetchone()["c"]
            self.assertEqual(count, 1, f"Expected 1 record, found {count}")

        print("[PASS] Case 7: Concurrent upload requests verified (both return same ID, exactly 1 DB record)")


if __name__ == '__main__':
    unittest.main()

