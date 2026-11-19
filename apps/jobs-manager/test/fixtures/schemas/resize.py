# Resizes the PPM image on stdin to each of params.sizes and returns every result inline, base64.
import base64, json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ppm import read_ppm, resize, write_ppm

params = json.loads(os.environ["JOB_PARAMS"])
try:
    width, height, pixels = read_ppm(sys.stdin.buffer.read())
except ValueError as e:
    print(json.dumps({"code": "bad_image", "detail": str(e)}), file=sys.stderr)
    sys.exit(2)
for size in params["sizes"]:
    w, h, out = resize(width, height, pixels, size)
    data = base64.b64encode(write_ppm(w, h, out)).decode()
    if os.environ.get("RESIZE_BROKEN_BASE64"):
        data = "not base64!!"
    print(json.dumps({"size": size, "width": w, "height": h, "data": data}), flush=True)
