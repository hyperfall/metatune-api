#!/usr/bin/env python3.11
# dejavu_cli.py

import os
import sys
import json
from dejavu import Dejavu
from dejavu.logic.recognizer.file_recognizer import FileRecognizer

# Build config from ENV (Railway‐style or fallbacks)
config = {
    # <-- specify which database backend to use
    "database_type": os.getenv("DJV_DB_TYPE", os.getenv("PG_DB_TYPE", "postgres")).lower(),

    # <-- pass only the host/user/password/name/port here
    "database": {
        "host":     os.getenv("DJV_DB_HOST",  os.getenv("PGHOST",     "localhost")),
        "user":     os.getenv("DJV_DB_USER",  os.getenv("PGUSER",     "postgres")),
        "password": os.getenv("DJV_DB_PASS",  os.getenv("PGPASSWORD", "")),
        "database": os.getenv("DJV_DB_NAME",  os.getenv("PGDATABASE", "postgres")),
        "port":     int(os.getenv("DJV_DB_PORT", os.getenv("PGPORT",   "5432"))),
    },

    "fingerprint_limit":  int(os.getenv("DJV_FP_LIMIT",       "5")),
    "match_threshold":    float(os.getenv("DJV_MATCH_THRESHOLD","0.2")),
}


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "recognize":
        print("Usage: dejavu_cli.py recognize <file> --format json", file=sys.stderr)
        sys.exit(1)

    file_path = sys.argv[2]
    if not os.path.isfile(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        sys.exit(2)

    # Initialize Dejavu
    djv = Dejavu(config)
    recognizer = FileRecognizer(djv)

    try:
        result = recognizer.recognize_file(file_path)
    except AttributeError:
        # older or alternate API
        result = djv.recognize(FileRecognizer, file_path)

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
