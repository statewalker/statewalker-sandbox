# Prints one valid, one invalid and one non-JSON line to stdout, and a matching and a
# non-matching JSON line to stderr; exits 0.
echo '{"n":1}'
echo '{"n":"two"}'
echo 'plain text'
echo '{"code":"warn","detail":"low disk"}' >&2
echo '{"level":"warn"}' >&2
