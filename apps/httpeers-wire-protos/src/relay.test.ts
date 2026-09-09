/**
 * The two risks note 15 left open:
 *   R1. Does half-close propagate over a RELAYED connection?
 *   R2. Does backpressure hold under a body larger than the yamux window?
 *
 * Both pass on libp2p 3.3.8 + @libp2p/circuit-relay-v2 4.2.11. See note 17 --
 * getting here required fixing a mixed 2.x/3.x dependency tree that had passed
 * 46 tests without exercising the mismatched boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { serveWire, wireRemote } from './transport-wire.js'

let relay: Libp2p, listener: Libp2p, dialer: Libp2p
let remote: ReturnType<typeof wireRemote>
let relayedAddr: string
const observed: any = {}

beforeAll(async () => {
  relay = await createLibp2p({
    privateKey: await generateKeyPair('Ed25519'),
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
    services: {
      identify: identify(),
      // Defaults would cut off the 8 MB transfer in R2.
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 10,
          defaultDurationLimit: 600_000,
          defaultDataLimit: 1024n * 1024n * 1024n
        }
      })
    }
  })
  const relayAddr = relay.getMultiaddrs()[0].toString()

  const mkClient = async () => createLibp2p({
    privateKey: await generateKeyPair('Ed25519'),
    addresses: { listen: ['/p2p-circuit'] },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()], streamMuxers: [yamux()],
    services: { identify: identify() }
  })

  listener = await mkClient()
  dialer = await mkClient()

  await serveWire(listener, async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/drain') {
      let bytes = 0, chunks = 0
      const reader = req.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (value != null) { bytes += value.byteLength; chunks++ }
        if (done) break              // <- only reachable if half-close propagates
      }
      observed.chunks = chunks
      return new Response(JSON.stringify({ bytes, chunks }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response('ok')
  })

  await listener.dial(multiaddr(relayAddr))
  // The reservation appears asynchronously AFTER dial resolves -- poll for it.
  for (let i = 0; i < 40 && !listener.getMultiaddrs().some(a => a.toString().includes('p2p-circuit')); i++) {
    await new Promise(r => setTimeout(r, 250))
  }
  relayedAddr = listener.getMultiaddrs().find(a => a.toString().includes('p2p-circuit'))!.toString()
  await dialer.dial(multiaddr(relayedAddr))
  remote = wireRemote(dialer)
}, 60_000)

afterAll(async () => { await dialer?.stop(); await listener?.stop(); await relay?.stop() })

describe('over a circuit relay', () => {
  it('R0: establishes a relayed connection', () => {
    expect(relayedAddr).toContain('p2p-circuit')
  })

  it('R1: half-close propagates -- the request body terminates', async () => {
    const body = new ReadableStream<Uint8Array>({
      start (c) { c.enqueue(new TextEncoder().encode('hello relay')); c.close() }
    })
    const res = await remote(listener.peerId.toString(),
      new Request('http://peer/drain', { method: 'POST', body, duplex: 'half' } as any))
    expect(res.status).toBe(200)
    expect((await res.json() as any).bytes).toBe(11)
  }, 30_000)

  it('R2: 8 MB body over the relay, exercising backpressure', async () => {
    const CHUNK = 64 * 1024, TOTAL = 8 * 1024 * 1024
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull (c) {
        if (sent >= TOTAL) { c.close(); return }
        c.enqueue(new Uint8Array(CHUNK).fill(66)); sent += CHUNK
      }
    })
    const res = await remote(listener.peerId.toString(),
      new Request('http://peer/drain', { method: 'POST', body, duplex: 'half' } as any))
    const out = await res.json() as any
    expect(out.bytes).toBe(TOTAL)
    expect(out.chunks).toBeGreaterThan(1)     // genuinely streamed, not one blob
  }, 60_000)
})
