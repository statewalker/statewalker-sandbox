// Reads text from stdin and reports the params.top most frequent words.
const { top = 3 }: { top?: number } = JSON.parse(process.env.JOB_PARAMS || "{}") ?? {};
let text = "";
for await (const chunk of process.stdin) text += chunk;
const counts = new Map<string, number>();
for (const word of text.toLowerCase().match(/[a-z']+/g) ?? [])
  counts.set(word, (counts.get(word) ?? 0) + 1);
const ranked = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, top);
for (const [word, count] of ranked) console.log(JSON.stringify({ word, count }));
