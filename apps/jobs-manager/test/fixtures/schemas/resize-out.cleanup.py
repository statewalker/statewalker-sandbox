# Deletes the files a resize-out job reported (only inside its results folder), then the folder.
import json, os, sys

if os.environ.get("CLEANUP_FAIL"):
    print("cleanup refused (CLEANUP_FAIL is set)", file=sys.stderr)
    sys.exit(1)
out_dir = os.path.realpath(os.environ["JOB_OUTPUT_DIR"])
for line in sys.stdin:
    message = json.loads(line).get("message")
    if isinstance(message, dict) and "path" in message:
        path = os.path.realpath(message["path"])
        if os.path.dirname(path) == out_dir and os.path.exists(path):
            os.remove(path)
if os.path.isdir(out_dir):
    os.rmdir(out_dir)  # fails, and so keeps the job, if anything unexpected is left in it
