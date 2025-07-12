import os
import sys
import json
from dejavu import Dejavu
from dejavu.recognize import FileRecognizer

# Build config from environment variables
config = {
    "database": {
        "host": os.getenv("DJV_DB_HOST", "localhost"),
        "user": os.getenv("DJV_DB_USER", "dejavu_user"),
        "password": os.getenv("DJV_DB_PASS", "supersecret"),
        "database": os.getenv("DJV_DB_NAME", "dejavu_db"),
        "port": int(os.getenv("DJV_DB_PORT", "5432")),
        "type": os.getenv("DJV_DB_TYPE", "postgres")
    },
    "fingerprint_limit": int(os.getenv("DJV_FP_LIMIT", "5")),
    "match_threshold": float(os.getenv("DJV_MATCH_THRESHOLD", "0.2"))
}

# Init Dejavu
djv = Dejavu(config)

# CLI usage: python3 -m utils.dejavu recognize <file> --format json
if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "recognize":
        file_path = sys.argv[2]
        recognizer = FileRecognizer(djv)
        result = recognizer.recognize_file(file_path)
        
        if "--format" in sys.argv and "json" in sys.argv:
            print(json.dumps(result, indent=2))
        else:
            print(result)
    else:
        print("Usage: python3 -m utils.dejavu recognize <file> --format json")
