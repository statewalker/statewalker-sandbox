# Deletes what a resize-s3 job uploaded, with the presigned DELETE URLs from its params.
import json, os, sys, urllib.error, urllib.request

failed = False
for target in json.loads(os.environ["JOB_PARAMS"])["targets"]:
    try:
        urllib.request.urlopen(urllib.request.Request(target["deleteUrl"], method="DELETE")).close()
    except urllib.error.HTTPError as e:
        print("DELETE %s: %d %s" % (target["deleteUrl"].split("?")[0], e.code, e.reason),
              file=sys.stderr)
        failed = True
sys.exit(1 if failed else 0)
