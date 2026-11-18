// Long-running TypeScript task: one JSON line per tick for `seconds` (default 30).
type Params = { seconds?: number; intervalMs?: number };

const { seconds = 30, intervalMs = 1000 }: Params =
  JSON.parse(process.env.JOB_PARAMS || "{}") ?? {};
const ticks = Math.round((seconds * 1000) / intervalMs);

for (let tick = 1; tick <= ticks; tick++) {
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  console.log(JSON.stringify({ tick, of: ticks, at: Date.now() }));
}
