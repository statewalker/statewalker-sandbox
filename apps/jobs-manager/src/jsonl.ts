import type { Json } from "./types.ts";

/** Splits a byte stream into text lines (without the terminators), flushing a final unterminated line. */
export async function* lines(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer.replace(/\r$/, "");
}

/** A line that is valid JSON becomes that value; anything else is kept as the raw string. */
export function parseLine(line: string): Json {
  try {
    return JSON.parse(line) as Json;
  } catch {
    return line;
  }
}
