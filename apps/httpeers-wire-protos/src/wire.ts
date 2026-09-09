/**
 * The envelope wire format.
 *
 *     <JSON.stringify(envelope)>\n<body bytes...>
 *
 * JSON.stringify never emits a literal \n, so the first 0x0a unambiguously
 * terminates the envelope. Everything after it is body, and end-of-stream is
 * end-of-body -- there is no length header and no chunk framing to get wrong.
 *
 * Borrowed from @statewalker/webrun-http-streams. This sidesteps all three
 * @libp2p/http defects at once (see note 15):
 *  - the envelope carries the FULL url, query included
 *  - the body needs no content-length, so nothing truncates it
 *  - there is no chunked encoding to mis-encode or fail to decode
 */

import type { Stream } from '@libp2p/interface'

export interface RequestEnvelope {
  url: string
  method: string
  headers: Array<[string, string]>
}

export interface ResponseEnvelope {
  status: number
  statusText: string
  headers: Array<[string, string]>
}

const NEWLINE = 0x0a
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function asBytes (chunk: unknown): Uint8Array {
  const c = chunk as { subarray: (s?: number, e?: number) => Uint8Array }
  return c.subarray()
}

async function send (stream: Stream, bytes: Uint8Array): Promise<void> {
  if (!stream.send(bytes)) await stream.onDrain()
}

/** Write `<envelope>\n<body>` then half-close the write side. */
export async function writeMessage (
  stream: Stream,
  envelope: unknown,
  body: ReadableStream<Uint8Array> | null
): Promise<void> {
  await send(stream, encoder.encode(`${JSON.stringify(envelope)}\n`))

  if (body != null) {
    const reader = body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (value != null && value.byteLength > 0) await send(stream, value)
      if (done) break
    }
  }

  // Half-close: signals end-of-body. The stream stays READABLE for the reply.
  await stream.close()
}

/** Read the envelope, and expose the remainder as a lazy body stream. */
export async function readMessage<E> (
  stream: Stream
): Promise<{ envelope: E, body: ReadableStream<Uint8Array> }> {
  const iter = stream[Symbol.asyncIterator]()
  const parts: Uint8Array[] = []
  // ADOPTION DELTA (the only edit to this file; see PROVENANCE.md). Annotated
  // rather than inferred: `asBytes` returns `Uint8Array<ArrayBufferLike>`, and
  // TypeScript 6 infers `Uint8Array<ArrayBuffer>` from `new Uint8Array(0)`, so
  // the `tail = chunk.subarray(...)` below does not typecheck without this.
  // Type-level only -- the emitted code is unchanged.
  let tail: Uint8Array = new Uint8Array(0)

  while (true) {
    const next = await iter.next()
    if (next.done === true) throw new Error('stream ended before envelope delimiter')
    const chunk = asBytes(next.value)
    if (chunk.byteLength === 0) continue

    const nl = chunk.indexOf(NEWLINE)
    if (nl === -1) { parts.push(chunk); continue }

    parts.push(chunk.subarray(0, nl))
    tail = chunk.subarray(nl + 1)
    break
  }

  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const head = new Uint8Array(total)
  let off = 0
  for (const p of parts) { head.set(p, off); off += p.byteLength }

  const envelope = JSON.parse(decoder.decode(head)) as E

  // Lazy: chunks are pulled from the wire as the consumer reads them, so a
  // large body is never materialised.
  const body = new ReadableStream<Uint8Array>({
    async pull (controller) {
      if (tail.byteLength > 0) {
        controller.enqueue(tail)
        tail = new Uint8Array(0)
        return
      }
      const next = await iter.next()
      if (next.done === true) { controller.close(); return }
      const chunk = asBytes(next.value)
      if (chunk.byteLength > 0) controller.enqueue(chunk)
    }
  })

  return { envelope, body }
}

export const toEnvelope = (req: Request): RequestEnvelope => ({
  url: req.url,                              // FULL url -- query preserved
  method: req.method,
  headers: [...req.headers.entries()]
})

export const fromEnvelope = (
  env: RequestEnvelope, body: ReadableStream<Uint8Array> | null
): Request => new Request(env.url, {
  method: env.method,
  headers: env.headers,
  body: env.method === 'GET' || env.method === 'HEAD' ? null : body,
  // @ts-expect-error required by undici for a streaming body
  duplex: 'half'
})
