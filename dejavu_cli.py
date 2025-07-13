# dejavu_cli.py

import os
import sys
import json
from dejavu import Dejavu
from dejavu.recognize import FileRecognizer

# Build config from environment variables
config = {
    "database": {
        "host":     os.getenv("DJV_DB_HOST"    , os.getenv("PGHOST"    , "localhost")),
        "user":     os.getenv("DJV_DB_USER"    , os.getenv("PGUSER"    , "postgres")),
        "password": os.getenv("DJV_DB_PASS"    , os.getenv("PGPASSWORD", "")),
        "database": os.getenv("DJV_DB_NAME"    , os.getenv("PGDATABASE", "postgres")),
        "port":     int(os.getenv("DJV_DB_PORT", os.getenv("PGPORT"    , "5432"))),
        "type":     os.getenv("DJV_DB_TYPE"    , "postgres")
    },
    "fingerprint_limit":  int(os.getenv("DJV_FP_LIMIT"       , "5")),
    "match_threshold":    float(os.getenv("DJV_MATCH_THRESHOLD", "0.2"))
}

def main():
    if len(sys.argv) < 3 or sys.argv[1] != "recognize":
        print("Usage: python dejavu_cli.py recognize <file> --format json", file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[2]
    djv = Dejavu(config)
    recognizer = FileRecognizer(djv)

    try:
        result = recognizer.recognize_file(file_path)
        # JSON output
        print(json.dumps(result, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(2)

if __name__ == "__main__":
    main()
