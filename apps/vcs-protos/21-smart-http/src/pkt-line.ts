/**
 * git's pkt-line framing (Documentation/gitprotocol-common.txt) and side-band multiplexing:
 * a packet is 4 hex digits of total length (header included) then data; "0000" flush, "0001"
 * delimiter, "0002" response end (protocol v2); lengths 0003 and 0004 are invalid, the maximum is
 * 65520 (LARGE_PACKET_MAX). Side-band packets carry a band byte: 1 data, 2 progress, 3 error.
 */
export class PktError extends Error {
  override name = "PktError";
}
export type Pkt =
  | { kind: "data"; data: Uint8Array }
  | { kind: "flush" }
  | { kind: "delim" }
  | { kind: "end" };

const enc = new TextEncoder();
const dec = new TextDecoder();
export const MAX_PKT = 65520;
/** side-band-64k data per packet: the maximum less the header and the band byte */
export const MAX_SIDEBAND_DATA = MAX_PKT - 5;
export const FLUSH = enc.encode("0000");
export const DELIM = enc.encode("0001");
export const RESPONSE_END = enc.encode("0002");

const hex4 = (n: number) => n.toString(16).padStart(4, "0");

export function pkt(data: string | Uint8Array): Uint8Array {
  const body = typeof data === "string" ? enc.encode(data) : data;
  if (body.length + 4 > MAX_PKT) throw new PktError(`packet of ${body.length} bytes is too long`);
  const out = new Uint8Array(body.length + 4);
  out.set(enc.encode(hex4(body.length + 4)));
  out.set(body, 4);
  return out;
}

/** `data` as side-band packets on `band`, each within git's 65520-byte limit. */
export function sideband(band: number, data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += MAX_SIDEBAND_DATA) {
    const part = data.subarray(i, i + MAX_SIDEBAND_DATA);
    const body = new Uint8Array(part.length + 1);
    body[0] = band;
    body.set(part, 1);
    out.push(pkt(body));
  }
  return out;
}

/** Reads packets from a byte stream split anywhere. */
export class PktReader {
  private it: AsyncIterator<Uint8Array>;
  private buf = new Uint8Array(0);
  private off = 0;
  constructor(src: AsyncIterable<Uint8Array>) {
    this.it = src[Symbol.asyncIterator]();
  }
  private async fill(n: number): Promise<boolean> {
    while (this.buf.length - this.off < n) {
      const r = await this.it.next();
      if (r.done) return false;
      const rest = this.buf.subarray(this.off);
      const next = new Uint8Array(rest.length + r.value.length);
      next.set(rest);
      next.set(r.value, rest.length);
      this.buf = next;
      this.off = 0;
    }
    return true;
  }
  /** The next packet, or null at a clean end of stream (between packets). */
  async read(): Promise<Pkt | null> {
    if (!(await this.fill(4))) {
      if (this.buf.length - this.off === 0) return null;
      throw new PktError("stream ends inside a packet header");
    }
    const head = dec.decode(this.buf.subarray(this.off, this.off + 4));
    if (!/^[0-9a-f]{4}$/.test(head))
      throw new PktError(`bad packet length ${JSON.stringify(head)}`);
    const len = Number.parseInt(head, 16);
    this.off += 4;
    if (len === 0) return { kind: "flush" };
    if (len === 1) return { kind: "delim" };
    if (len === 2) return { kind: "end" };
    if (len < 5) throw new PktError(`invalid packet length ${len}`);
    if (len > MAX_PKT) throw new PktError(`packet length ${len} over ${MAX_PKT}`);
    if (!(await this.fill(len - 4))) throw new PktError("stream ends inside a packet");
    const data = this.buf.slice(this.off, this.off + len - 4);
    this.off += len - 4;
    return { kind: "data", data };
  }
  /** Releases the source (an early stop). */
  async close() {
    await this.it.return?.();
  }
}

/** A data packet as text without its trailing LF (git allows the LF to be absent). */
export const text = (p: Pkt): string | undefined =>
  p.kind === "data" ? dec.decode(p.data).replace(/\n$/, "") : undefined;

/**
 * The band-1 bytes of side-band packets up to a flush; band 2 goes to `progress`, band 3 throws
 * (the remote's error).
 */
export async function* readSideband(
  r: PktReader,
  progress: (m: string) => void,
): AsyncGenerator<Uint8Array> {
  for (;;) {
    const p = await r.read();
    if (!p) throw new PktError("stream ends before the side-band flush");
    if (p.kind === "flush") return;
    if (p.kind !== "data" || p.data.length === 0)
      throw new PktError(`unexpected ${p.kind} in side-band`);
    const band = p.data[0];
    const body = p.data.subarray(1);
    if (band === 1) yield body;
    else if (band === 2) progress(dec.decode(body));
    else if (band === 3) throw new PktError(`remote error: ${dec.decode(body).trim()}`);
    else throw new PktError(`unknown side-band ${band}`);
  }
}
