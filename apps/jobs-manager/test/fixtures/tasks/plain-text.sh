# Mixed output: a non-JSON line, a blank line (ignored) and a JSON line without a trailing newline.
echo "not json at all"
echo ""
printf '{"last":true}'
