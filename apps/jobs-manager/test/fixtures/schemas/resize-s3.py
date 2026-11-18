# Resizes the PPM image on stdin and uploads each result to a presigned URL given in params
# (as with S3), reporting the URL to read it from.
import json, os, sys, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from ppm import read_ppm, resize, write_ppm

params = json.loads(os.environ["JOB_PARAMS"])
width, height, pixels = read_ppm(sys.stdin.buffer.read())
for target in params["targets"]:
    w, h, out = resize(width, height, pixels, target["size"])
    request = urllib.request.Request(target["uploadUrl"], data=write_ppm(w, h, out), method="PUT",
                                     headers={"content-type": "image/x-portable-pixmap"})
    urllib.request.urlopen(request).close()
    print(json.dumps({"size": target["size"], "width": w, "height": h, "url": target["readUrl"]}),
          flush=True)
