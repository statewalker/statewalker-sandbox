/**
 * Transport robustness. Written RED first -- see note 18.
 *
 * B1 (205) and B5 (concurrency cliff) both FAILED on the first run and drove
 * fixes in transport-wire.ts. B7 documents a constraint of HTTP itself.
 *
 *   B1. Bodiless status codes beyond 204/304: 205, and 1xx.
 *   B2. HEAD responses must not carry a body.
 *   B3. A zero-length body must still terminate.
 *   B4. A handler that throws must surface as an error, not a hang.
 *   B5. Concurrent streams over one connection (maxInboundStreams default 32).
 *   B6/B7/B8. Non-ASCII in URL and header values.
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

let server: Libp2p, client: Libp2p
let remote: ReturnType<typeof wireRemote>

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

    // Bodiless statuses. `new Response(body, { status })` throws for these,
    // so the handler must pass null -- and so must the client side.
    const m = /^\/status\/(\d+)$/.exec(url.pathname)
    if (m != null) return new Response(null, { status: Number(m[1]) })

    if (url.pathname === '/head') {
      return req.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { 'content-length': '5' } })
        : new Response('hello')
    }

    if (url.pathname === '/empty-echo') {
      const text = await req.text()
      return new Response(JSON.stringify({ length: text.length }),
        { headers: { 'content-type': 'application/json' } })
    }

    if (url.pathname === '/boom') throw new Error('handler exploded')

    if (url.pathname === '/slow') {
      await new Promise(r => setTimeout(r, 100))
      return new Response(url.searchParams.get('n') ?? '?')
    }

    if (url.pathname === '/echo-meta') {
      return new Response(JSON.stringify({
        url: req.url,
        note: req.headers.get('x-note'),
        enc: req.headers.get('x-enc')
      }), { headers: { 'content-type': 'application/json' } })
    }

    return new Response('not found', { status: 404 })
  })

  await client.dial(multiaddr(server.getMultiaddrs()[0].toString()))
  remote = wireRemote(client)
}, 30_000)

afterAll(async () => { await client?.stop(); await server?.stop() })

const target = () => server.peerId.toString()

describe('bodiless statuses', () => {
  // 204 and 304 already special-cased; 205 is the one that was missed.
  for (const status of [204, 205, 304]) {
    it(`B1: ${status} round-trips with a null body`, async () => {
      const res = await remote(target(), new Request(`http://peer/status/${status}`))
      expect(res.status).toBe(status)
      expect(res.body).toBeNull()
    })
  }

  it('B2: a HEAD response carries no body but keeps its headers', async () => {
    const res = await remote(target(), new Request('http://peer/head', { method: 'HEAD' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('5')
    expect(await res.text()).toBe('')
  })
})

describe('edge cases', () => {
  it('B3: a zero-length POST body terminates', async () => {
    const res = await remote(target(),
      new Request('http://peer/empty-echo', { method: 'POST', body: '' }))
    expect((await res.json() as any).length).toBe(0)
  })

  it('B4: a throwing handler surfaces as a rejection, not a hang', async () => {
    await expect(
      remote(target(), new Request('http://peer/boom'))
    ).rejects.toThrow()
  }, 10_000)

  it('B6: non-ASCII in the url survives', async () => {
    const res = await remote(target(), new Request('http://peer/echo-meta?ville=Z%C3%BCrich'))
    const body = await res.json() as any
    expect(new URL(body.url).searchParams.get('ville')).toBe('Zürich')
  })

  it('B7: header values are ByteString-limited -- a constraint, not a bug', () => {
    // This is the HTTP spec, not our transport: header values are ByteString
    // (latin1). The em dash (U+2014) is rejected by `new Request` itself,
    // before anything reaches the wire.
    expect(() => new Request('http://peer/x', { headers: { 'x-note': 'a \u2014 b' } }))
      .toThrow(/ByteString/)
  })

  it('B8: latin1 header values round-trip; anything else must be encoded', async () => {
    const res = await remote(target(), new Request('http://peer/echo-meta', {
      headers: { 'x-note': 'caf\u00e9 na\u00efve', 'x-enc': encodeURIComponent('\u2014 dash') }
    }))
    const body = await res.json() as any
    expect(body.note).toBe('café naïve')
    expect(decodeURIComponent(body.enc)).toBe('— dash')
  })
})

describe('concurrency', () => {
  it('B5: 40 concurrent requests over one connection', async () => {
    // Default maxInboundStreams is 32, so 40 crosses it deliberately.
    // Before the fix this produced 8 x StreamResetError.
    const results = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const res = await remote(target(), new Request(`http://peer/slow?n=${i}`))
        return res.text()
      })
    )
    expect(results).toEqual(Array.from({ length: 40 }, (_, i) => String(i)))
  }, 30_000)
})
