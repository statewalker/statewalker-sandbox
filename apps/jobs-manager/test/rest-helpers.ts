import type { JobMessage } from "../src/types.ts";

export type SseEvent = { id?: string; data: JobMessage };

/** Reads a text/event-stream body to its end (or until `stop` returns true). */
export async function readSse(
  response: Response,
  stop?: (e: SseEvent) => boolean,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let index = buffer.indexOf("\n\n"); index >= 0; index = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const fields = Object.fromEntries(
        block
          .split("\n")
          .filter((l) => !l.startsWith(":"))
          .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
      );
      if (fields.data === undefined) continue;
      const event = { id: fields.id, data: JSON.parse(fields.data) as JobMessage };
      events.push(event);
      if (stop?.(event)) {
        await reader.cancel();
        return events;
      }
    }
  }
  return events;
}

export function ndjson(text: string): JobMessage[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JobMessage);
}
