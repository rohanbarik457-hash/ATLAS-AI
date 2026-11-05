import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import connection

def run_migration():
    with connection() as conn:
        with conn.transaction():
            conn.execute("ALTER TABLE documents ADD COLUMN IF NOT EXISTS checksum_sha256 text")
            conn.execute("ALTER TABLE documents ADD COLUMN IF NOT EXISTS error_message text")
            conn.execute("ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()")
            conn.execute("ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_status_check")
            conn.execute("ALTER TABLE documents ADD CONSTRAINT documents_status_check CHECK(status IN ('queued','pending','processing','ready','failed','retired'))")
            conn.execute("CREATE INDEX IF NOT EXISTS documents_tenant_checksum_idx ON documents(tenant_id, checksum_sha256)")
        print("Migration applied successfully!")

if __name__ == '__main__':
    run_migration()
