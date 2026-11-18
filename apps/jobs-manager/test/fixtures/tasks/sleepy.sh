# Long-running with a child process: reports both pids, then waits for the child.
sleep "${SLEEP_SECONDS:-30}" &
echo "{\"pid\":$$,\"child\":$!}"
wait
echo '{"woke":true}'
