/**
 * The transport: a raw libp2p protocol handler in place of @libp2p/http.
 *
 * `connection` is handed to us directly by `node.handle`, so the proven peer id
 * is MORE available here than through @libp2p/http, not less.
 *
 * API NOTE: `node.handle(protocol, handler)` passes (stream, connection) as TWO
 * POSITIONAL ARGUMENTS, not a destructured { stream, connection }. Getting this
 * wrong produces silent timeouts rather than a type error.
 */

import type { Libp2p, Stream, Connection } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import { writeMessage, readMessage, toEnvelope, fromEnvelope } from './wire.js'
import type { RequestEnvelope, ResponseEnvelope } from './wire.js'
import { registerPeer } from './peer-context.js'
import type { FetchHandler, PeerIdStr } from './types.js'

export const PROTOCOL = '/httpeers/1.0.0'

/**
 * Statuses that must not carry a body -- `new Response(body, { status })`
 * throws for these. The fetch spec calls them "null body status".
 * 205 was missing before robustness.test.ts caught it.
 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

/**
 * One libp2p stream is opened per in-flight request. The libp2p default of 32
 * inbound streams therefore caps concurrent requests per connection, and
 * exceeding it RESETS streams rather than queueing them -- callers see
 * StreamResetError, not a delay. Raised deliberately; see note 18.
 */
export const DEFAULT_MAX_STREAMS = 512

export interface ServeWireInit {
  maxInboundStreams?: number
  maxOutboundStreams?: number
}

export async function serveWire (
  node: Libp2p, handler: FetchHandler, init: ServeWireInit = {}
): Promise<void> {
  await node.handle(PROTOCOL, (stream: Stream, connection: Connection) => {
    void (async () => {
      try {
        const { envelope, body } = await readMessage<RequestEnvelope>(stream)
        const req = fromEnvelope(envelope, body)
        registerPeer(req, connection.remotePeer.toString())

        const res = await handler(req)
        // A HEAD response, and any null-body status, must not put bytes on the
        // wire -- the far side cannot construct a Response for them.
        const sendBody = req.method !== 'HEAD' && !NULL_BODY_STATUS.has(res.status)
        await writeMessage(stream, {
          status: res.status,
          statusText: res.statusText,
          headers: [...res.headers.entries()]
        } satisfies ResponseEnvelope, sendBody ? res.body : null)
      } catch (err) {
        try { stream.abort(err as Error) } catch { /* already gone */ }
      }
    })()
  }, {
    runOnLimitedConnection: true,
    maxInboundStreams: init.maxInboundStreams ?? DEFAULT_MAX_STREAMS,
    maxOutboundStreams: init.maxOutboundStreams ?? DEFAULT_MAX_STREAMS
  })
}

export function wireRemote (node: Libp2p) {
  return async function remote (target: PeerIdStr, req: Request): Promise<Response> {
    const stream = await (node as any).dialProtocol(multiaddr(`/p2p/${target}`), PROTOCOL, {
      runOnLimitedConnection: true
    }) as Stream

    // Send envelope + body, half-close, then read the reply off the same stream.
    await writeMessage(stream, toEnvelope(req), req.body)
    const { envelope, body } = await readMessage<ResponseEnvelope>(stream)

    const nullBody = req.method === 'HEAD' || NULL_BODY_STATUS.has(envelope.status)
    return new Response(nullBody ? null : body, {
      status: envelope.status,
      statusText: envelope.statusText,
      headers: envelope.headers
    })
  }
}
