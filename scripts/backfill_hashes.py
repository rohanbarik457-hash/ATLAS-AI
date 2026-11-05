import sys
import hashlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import connection
from app.aws import client
from app.config import settings

def update_hashes():
    s = settings()
    s3 = client('s3')

    with connection() as conn:
        rows = conn.execute("SELECT id, s3_key, checksum_sha256 FROM documents").fetchall()
        for r in rows:
            if not r['checksum_sha256']:
                try:
                    obj = s3.get_object(Bucket=s.s3_bucket, Key=r['s3_key'])
                    data = obj['Body'].read()
                    h = hashlib.sha256(data).hexdigest()
                    conn.execute("UPDATE documents SET checksum_sha256=%s WHERE id=%s", (h, r['id']))
                    print("Updated doc", r['id'], "hash:", h)
                except Exception as e:
                    print("Error updating doc", r['id'], e)

if __name__ == '__main__':
    update_hashes()

