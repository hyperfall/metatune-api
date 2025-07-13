#!/usr/bin/env python3
# audfprint_cli.py

import sys, json
from audfprint import match

DB = "/opt/audfprint-db.npz"   # adjust if you precompute somewhere else

def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: audfprint_cli.py <file>"}))
        sys.exit(1)
    fname = sys.argv[1]
    try:
        db = match.load_database(DB)
        recs = match.match_file(db, fname, n_top=1)
        if not recs:
            print(json.dumps({}))
            return
        songid, offset, score = recs[0]
        print(json.dumps({"songid": songid, "offset": offset, "score": score}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(2)

if __name__ == "__main__":
    main()
