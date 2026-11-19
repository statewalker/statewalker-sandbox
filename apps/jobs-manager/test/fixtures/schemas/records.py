# Sums the `amount` of the JSON records on stdin, one per line.
import json, sys

count, total = 0, 0
for line in sys.stdin:
    if line.strip():
        record = json.loads(line)
        count, total = count + 1, total + record["amount"]
print(json.dumps({"count": count, "total": total}))
