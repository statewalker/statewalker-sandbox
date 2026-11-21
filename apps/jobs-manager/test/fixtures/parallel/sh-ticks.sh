# Long-running: params.ticks lines, params.intervalMs apart.
ticks=$(echo "$JOB_PARAMS" | sed -E 's/.*"ticks":([0-9]+).*/\1/')
interval=$(echo "$JOB_PARAMS" | sed -E 's/.*"intervalMs":([0-9]+).*/\1/')
for tick in $(seq 1 "$ticks"); do
  sleep "$(awk "BEGIN { print $interval / 1000 }")"
  echo "{\"tick\":$tick,\"lang\":\"bash\"}"
done
