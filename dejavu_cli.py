#!/usr/bin/env python3
# dejavu_cli.py

import os
import sys
import json
from dejavu import Dejavu
from dejavu.logic.recognizer import FileRecognizer

# Build config from ENV (Railway‐style or fallbacks)
config = {
    "database": {
        "host":     os.getenv("DJV_DB_HOST",  os.getenv("PGHOST",     "localhost")),
        "user":     os.getenv("DJV_DB_USER",  os.getenv("PGUSER",     "postgres")),
        "password": os.getenv("DJV_DB_PASS",  os.getenv("PGPASSWORD", "")),
        "database": os.getenv("DJV_DB_NAME",  os.getenv("PGDATABASE", "postgres")),
        "port":     int(os.getenv("DJV_DB_PORT", os.getenv("PGPORT",   "5432"))),
        "type":     os.getenv("DJV_DB_TYPE",  "postgres"),
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

    # Option A: use the helper on the class
    try:
        result = djv.recognize(FileRecognizer, file_path)
    except AttributeError:
        # Option B: or call the instance method directly
        recognizer = FileRecognizer(djv)
        result = recognizer.recognize_file(file_path)

    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
