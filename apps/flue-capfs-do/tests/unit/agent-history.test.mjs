// A stored agent session must stay a history providers accept, however it is trimmed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { trimHistory } from "../../src/agent-history.ts";

const turn = (i) => [
  { role: "user", content: `q${i}` },
  { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `c${i}` }] },
  { role: "toolResult", toolCallId: `c${i}`, content: "x".repeat(100) },
  { role: "assistant", stopReason: "stop", content: `a${i}` },
];
const history = Array.from({ length: 10 }, (_, i) => turn(i)).flat();

test("a trimmed history starts with a user message", () => {
  for (const max of [1, 2, 3, 5, 6, 7, 39]) {
    const kept = trimHistory(history, max, 1e6);
    assert.ok(kept.length <= max);
    if (kept.length) assert.equal(kept[0].role, "user", `max ${max}`);
  }
  const bytes = trimHistory(history, 200, 700);
  assert.ok(new TextEncoder().encode(JSON.stringify(bytes)).length <= 700);
  assert.equal(bytes[0].role, "user");
});

test("aborted and failed replies are not kept; bytes count UTF-8", () => {
  const kept = trimHistory(
    [
      { role: "user", content: "q" },
      { role: "assistant", stopReason: "aborted", content: "" },
      { role: "assistant", stopReason: "error", content: "" },
    ],
    200,
    1e6,
  );
  assert.deepEqual(
    kept.map((m) => m.role),
    ["user"],
  );
  const wide = [{ role: "user", content: "я".repeat(600) }];
  assert.equal(trimHistory(wide, 200, 1000).length, 0, "1200 bytes, though 600 characters");
});
