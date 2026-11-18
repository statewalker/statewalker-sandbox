# Long-running: params.ticks lines, params.intervalMs apart.
import json, os, time

params = json.loads(os.environ["JOB_PARAMS"])
for tick in range(1, params["ticks"] + 1):
    time.sleep(params["intervalMs"] / 1000)
    print(json.dumps({"tick": tick, "lang": "python"}), flush=True)
