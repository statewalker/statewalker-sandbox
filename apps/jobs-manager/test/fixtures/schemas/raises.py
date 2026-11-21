# Reports one step, then raises: Python prints the traceback to stderr and exits with 1.
import json

print(json.dumps({"step": 1}), flush=True)
raise ValueError("boom")
