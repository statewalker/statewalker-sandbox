# Exits with the code given in params.code, after a message on each stream.
code=$(echo "$JOB_PARAMS" | sed -E 's/.*"code":([0-9]+).*/\1/')
echo "{\"exiting\":$code}"
echo "exiting with $code" >&2
exit "$code"
