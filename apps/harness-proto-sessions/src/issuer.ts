// PROTOTYPE. The deployment's token issuer (#78), standing in for an identity provider: it
// signs short-lived access tokens that name only the user, the workspace and the expiry.

import { DurableObject } from "cloudflare:workers";
import { Biscuit, fromBase64, generateKeypair, toBase64 } from "@statewalker/webrun-biscuit";

const q = (s: string) => JSON.stringify(s);

export class Issuer extends DurableObject<{ TOKEN_TTL_MS?: string }> {
  async #keys(): Promise<{ secret: Uint8Array; public: Uint8Array }> {
    const k = await this.ctx.storage.get<{ secret: string; public: string }>("keys");
    if (k) return { secret: fromBase64(k.secret), public: fromBase64(k.public) };
    const kp = generateKeypair();
    await this.ctx.storage.put("keys", {
      secret: toBase64(kp.secretKey),
      public: toBase64(kp.publicKey),
    });
    return { secret: kp.secretKey, public: kp.publicKey };
  }
  async publicKey(): Promise<string> {
    return toBase64((await this.#keys()).public);
  }
  /** An access token: user, workspace, expiry. Nothing about roles or rights. */
  async login(user: string, workspace: string, ttlMs?: number) {
    const ttl = ttlMs ?? Number(this.env.TOKEN_TTL_MS ?? 3_600_000);
    const expires = Date.now() + ttl;
    const token = Biscuit.build(
      (await this.#keys()).secret,
      `user(${q(user)});\nworkspace(${q(workspace)});\nexpires(${expires});`,
    ).toBase64();
    return { token, expires };
  }
}
