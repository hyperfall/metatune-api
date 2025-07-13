#!/usr/bin/env python3.11
# dejavu_cli.py

import os
import sys
import json

from dejavu import Dejavu
from dejavu.logic.recognizer import FileRecognizer

# Build config from ENV (Railway‐style or fallbacks)
config = {
    # tell Dejavu which DB backend to use:
    "database_type": os.getenv("DJV_DB_TYPE", os.getenv("DB_TYPE", "postgres")),
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

    # Initialize Dejavu (this will also call .db.setup() under the hood)
    djv = Dejavu(config)

    # Try the convenience helper, else fall back
    try:
        # The `.recognize()` helper takes (RecognizerClass, *args)
        result = djv.recognize(FileRecognizer, file_path)
    except AttributeError:
        # older versions expect you to instantiate and call .recognize_file()
        recognizer = FileRecognizer(djv)
        result = recognizer.recognize_file(file_path)

    # Print JSON-formatted result
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
