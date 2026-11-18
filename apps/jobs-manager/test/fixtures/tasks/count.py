# Reads the whole input stream and reports its size, line count and the params it got.
import json, os, sys

data = sys.stdin.buffer.read()
print(json.dumps({"bytes": len(data), "lines": data.count(b"\n"), "params": json.loads(os.environ["JOB_PARAMS"])}))
