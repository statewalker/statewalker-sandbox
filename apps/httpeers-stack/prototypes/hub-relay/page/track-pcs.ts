// PROTOTYPE (hub-relay). Imported FIRST by main.ts: `@libp2p/webrtc` captures
// `globalThis.RTCPeerConnection` when it is evaluated, so the wrapper has to
// be in place before that module runs.
export const peerConnections: RTCPeerConnection[] = [];

const Native = globalThis.RTCPeerConnection;
globalThis.RTCPeerConnection = class extends Native {
  constructor(config?: RTCConfiguration) {
    super(config);
    peerConnections.push(this);
  }
} as typeof RTCPeerConnection;

export interface PcStats {
  index: number;
  state: RTCPeerConnectionState;
  /** Candidate types of the selected pair: host / srflx / prflx / relay (relay = through TURN). */
  local?: string;
  remote?: string;
  bytesSent: number;
  bytesReceived: number;
}

export async function pcStats(): Promise<PcStats[]> {
  return Promise.all(
    peerConnections.map(async (pc, index) => {
      const report = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      report.forEach((s: Record<string, unknown>) => {
        byId.set(s.id as string, s);
      });
      const transport = [...byId.values()].find((s) => s.type === "transport");
      const pair =
        (transport?.selectedCandidatePairId != null
          ? byId.get(transport.selectedCandidatePairId as string)
          : undefined) ??
        [...byId.values()].find((s) => s.type === "candidate-pair" && s.nominated === true);
      const local = pair ? byId.get(pair.localCandidateId as string) : undefined;
      const remote = pair ? byId.get(pair.remoteCandidateId as string) : undefined;
      return {
        index,
        state: pc.connectionState,
        local: local?.candidateType as string | undefined,
        remote: remote?.candidateType as string | undefined,
        bytesSent: Number(pair?.bytesSent ?? transport?.bytesSent ?? 0),
        bytesReceived: Number(pair?.bytesReceived ?? transport?.bytesReceived ?? 0),
      };
    }),
  );
}
