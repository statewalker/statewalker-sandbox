# Fails with an uncaught exception after one result line: the traceback goes to stderr, exit code 1.
import json

print(json.dumps({"step": 1}), flush=True)
raise ValueError("bad input")
