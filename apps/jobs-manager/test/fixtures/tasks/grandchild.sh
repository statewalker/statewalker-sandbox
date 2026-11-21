# Starts a background process that ignores SIGTERM and detaches its output, then waits.
(trap '' TERM; exec sleep 93) >/dev/null 2>&1 &
echo "{\"grandchild\":$!}"
wait
