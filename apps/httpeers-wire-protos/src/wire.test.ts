/**
 * Does the envelope transport actually fix the two show-stoppers?
 *
 * Q1. Does a query string survive?
 * Q2. Does a REQUEST body stream -- chunks arriving before the sender finishes?
 * Q3. Does a RESPONSE body stream?
 * Q4. Is the proven peer id still available?
 * Q5. Does a large body pass without being materialised?
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { identify } from '@libp2p/identify'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { generateKeyPair } from '@libp2p/crypto/keys'
import { multiaddr } from '@multiformats/multiaddr'
import { serveWire, wireRemote } from './transport-wire.js'
import { lookupPeer } from './peer-context.js'

let server: Libp2p, client: Libp2p
let remote: ReturnType<typeof wireRemote>
const observed: any = {}

const mk = async (listen: string[]) => createLibp2p({
  privateKey: await generateKeyPair('Ed25519'),
  addresses: { listen },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify() }
})

beforeAll(async () => {
  server = await mk(['/ip4/127.0.0.1/tcp/0'])
  client = await mk([])

  await serveWire(server, async (req) => {
    const url = new URL(req.url)
    observed.peer = lookupPeer(req)

    if (url.pathname === '/echo-url') {
      return new Response(JSON.stringify({ path: url.pathname, search: url.search }),
        { headers: { 'content-type': 'application/json' } })
    }

    if (url.pathname === '/drain') {
      // Record WHEN each chunk arrives, to prove incremental delivery.
      const arrivals: number[] = []
      const t0 = Date.now()
      let bytes = 0
      const reader = req.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (value != null) { arrivals.push(Date.now() - t0); bytes += value.byteLength }
        if (done) break
      }
      observed.arrivals = arrivals
      return new Response(JSON.stringify({ chunks: arrivals.length, bytes }),
        { headers: { 'content-type': 'application/json' } })
    }

    if (url.pathname === '/emit') {
      let n = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull (controller) {
          if (n >= 4) { controller.close(); return }
          controller.enqueue(new TextEncoder().encode(`chunk${n++};`))
          await new Promise(r => setTimeout(r, 60))
        }
      }))
    }

    return new Response('not found', { status: 404 })
  })

  await client.dial(multiaddr(server.getMultiaddrs()[0].toString()))
  remote = wireRemote(client)
}, 30_000)

afterAll(async () => { await client?.stop(); await server?.stop() })

describe('envelope transport', () => {
  it('Q1: preserves the query string', async () => {
    const res = await remote(server.peerId.toString(),
      new Request('http://peer/echo-url?a=1&b=two&empty='))
    const body = await res.json() as any
    expect(body.path).toBe('/echo-url')
    expect(body.search).toBe('?a=1&b=two&empty=')   // dropped by @libp2p/http
  })

  it('Q2: streams a REQUEST body incrementally', async () => {
    const sendTimes: number[] = []
    const t0 = Date.now()
    const body = new ReadableStream<Uint8Array>({
      async pull (controller) {
        if (sendTimes.length >= 4) { controller.close(); return }
        sendTimes.push(Date.now() - t0)
        controller.enqueue(new TextEncoder().encode(`part${sendTimes.length};`))
        await new Promise(r => setTimeout(r, 60))
      }
    })

    const res = await remote(server.peerId.toString(),
      new Request('http://peer/drain', { method: 'POST', body, duplex: 'half' } as any))

    const out = await res.json() as any
    expect(out.chunks).toBeGreaterThan(0)
    expect(out.bytes).toBe(24)                       // 4 x "partN;"

    // The proof: the FIRST chunk reached the server well before the LAST was
    // sent. A buffering transport cannot produce this.
    expect(observed.arrivals[0]).toBeLessThan(sendTimes[3])
  })

  it('Q3: streams a RESPONSE body incrementally', async () => {
    const res = await remote(server.peerId.toString(), new Request('http://peer/emit'))
    const arrivals: number[] = []
    const t0 = Date.now()
    const reader = res.body!.getReader()
    let text = ''
    while (true) {
      const { done, value } = await reader.read()
      if (value != null) { arrivals.push(Date.now() - t0); text += new TextDecoder().decode(value) }
      if (done) break
    }
    expect(text).toBe('chunk0;chunk1;chunk2;chunk3;')
    expect(arrivals.length).toBeGreaterThan(1)                        // not one blob
    expect(arrivals[arrivals.length - 1] - arrivals[0]).toBeGreaterThan(50)
  })

  it('Q4: exposes the proven peer id', async () => {
    await remote(server.peerId.toString(), new Request('http://peer/echo-url'))
    expect(observed.peer).toBe(client.peerId.toString())
  })

  it('Q5: passes a 4 MB body', async () => {
    const big = new Uint8Array(4 * 1024 * 1024).fill(65)
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull (controller) {
        if (sent) { controller.close(); return }
        sent = true
        controller.enqueue(big)
      }
    })
    const res = await remote(server.peerId.toString(),
      new Request('http://peer/drain', { method: 'POST', body, duplex: 'half' } as any))
    expect((await res.json() as any).bytes).toBe(4 * 1024 * 1024)
  }, 30_000)
})
