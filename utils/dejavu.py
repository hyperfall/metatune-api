# dejavu.py
import argparse
import json
from dejavu import Dejavu
from dejavu.recognize import FileRecognizer

# Load config
config = {
    "database": {
        "host": "localhost",
        "user": "root",
        "passwd": "yourpassword",
        "db": "dejavu"
    }
}

# Parse CLI arguments
parser = argparse.ArgumentParser(description="Dejavu Recognizer CLI")
subparsers = parser.add_subparsers(dest="command")

recognize_parser = subparsers.add_parser("recognize")
recognize_parser.add_argument("file", type=str, help="Path to the audio file")
recognize_parser.add_argument("--format", type=str, default="json", help="Output format")

args = parser.parse_args()

if args.command == "recognize":
    try:
        djv = Dejavu(config)
        result = djv.recognize(FileRecognizer, args.file)
        if args.format == "json":
            print(json.dumps(result))
        else:
            print(result)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
