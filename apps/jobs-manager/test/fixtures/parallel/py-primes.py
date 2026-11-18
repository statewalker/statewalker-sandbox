# CPU-bound: counts primes up to params.limit with a sieve, reporting progress in tenths.
import json, os

limit = json.loads(os.environ["JOB_PARAMS"])["limit"]
sieve = bytearray([1]) * (limit + 1)
sieve[0:2] = b"\x00\x00"
step = max(1, limit // 10)
for i in range(2, limit + 1):
    if sieve[i] and i * i <= limit:
        sieve[i * i :: i] = bytearray(len(range(i * i, limit + 1, i)))
    if i % step == 0:
        print(json.dumps({"progress": round(i / limit, 2)}), flush=True)
print(json.dumps({"primes": sum(sieve)}))
