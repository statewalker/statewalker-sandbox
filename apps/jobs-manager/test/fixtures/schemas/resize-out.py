# Resizes the PPM image on stdin to each of params.sizes, writes the results to the job's results
# folder (JOB_OUTPUT_DIR) and reports where each one is: its URL and its path on the server.
import json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ppm import read_ppm, resize, write_ppm

params = json.loads(os.environ["JOB_PARAMS"])
out_dir, out_url = os.environ["JOB_OUTPUT_DIR"], os.environ["JOB_OUTPUT_URL"]
width, height, pixels = read_ppm(sys.stdin.buffer.read())
for size in params["sizes"]:
    w, h, out = resize(width, height, pixels, size)
    path = os.path.join(out_dir, "%d.ppm" % size)
    with open(path, "wb") as f:
        f.write(write_ppm(w, h, out))
    print(json.dumps({"size": size, "width": w, "height": h, "url": out_url + "%d.ppm" % size,
                      "path": path, "bytes": os.path.getsize(path)}), flush=True)
