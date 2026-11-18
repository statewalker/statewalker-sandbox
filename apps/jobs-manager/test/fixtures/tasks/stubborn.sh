# Ignores SIGTERM, so only SIGKILL stops it.
trap '' TERM
echo '{"ready":true}'
while true; do sleep 0.1; done
