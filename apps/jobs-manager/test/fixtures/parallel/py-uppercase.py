# Stream transform: one JSON line per input line, upper-cased.
import json, sys

for number, line in enumerate(sys.stdin, start=1):
    print(json.dumps({"line": number, "text": line.rstrip("\n").upper()}), flush=True)
