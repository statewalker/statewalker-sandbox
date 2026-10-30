/** What a deployment says about itself, served next to the page as `/peershare.json`. */
export interface PeerShareConfig {
  /** The relay every peer reaches the mesh through. */
  relayAddrs: string[];
  /**
   * Where Guests' isolated sessions live, with `{name}` for the session name:
   * `https://{name}.p.sandclaw.ai`. Its shell must accept this page as a parent.
   */
  sessionOrigin: string;
  /** Let the browser dial a plain `ws://` relay on loopback (development, tests). */
  dev?: boolean;
}

export async function loadConfig(): Promise<PeerShareConfig> {
  const res = await fetch("/peershare.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`/peershare.json: ${res.status}`);
  return res.json();
}
