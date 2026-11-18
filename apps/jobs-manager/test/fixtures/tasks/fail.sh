# Writes one result line, two error lines (JSON and plain text), then fails.
echo '{"step":1}'
echo '{"warning":"disk almost full"}' >&2
echo 'boom: something broke' >&2
exit 3
