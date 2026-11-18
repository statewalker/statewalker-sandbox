// Long-running: params.ticks lines, params.intervalMs apart.
const { ticks, intervalMs }: { ticks: number; intervalMs: number } = JSON.parse(
  process.env.JOB_PARAMS!,
);
for (let tick = 1; tick <= ticks; tick++) {
  await new Promise((r) => setTimeout(r, intervalMs));
  console.log(JSON.stringify({ tick, lang: "typescript" }));
}
