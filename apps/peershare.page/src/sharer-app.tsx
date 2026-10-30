/**
 * The Sharer's page: `/peer-share#localUrl=http://127.0.0.1:9090&t=<token>`.
 * The fragment pairs it with the Bridge (rung 02); sharing starts as soon as
 * the page is open, and stops with the tab (ADR 0001).
 */

import { createRuntime, peershare, StartSharing } from "@statewalker/peershare";
import { browserMesh, idbSharerStore } from "@statewalker/peershare/browser";
import { BridgeStatus, PeerShareProvider, SharerScreen } from "@statewalker/peershare-react";
import { useEffect, useState } from "react";
import { type BridgeDiagnosis, diagnoseBridge } from "./bridge-diagnosis.js";
import type { PeerShareConfig } from "./config.js";

/** The Bridge's pairing, from the link the Bridge printed or opened. */
function pairingFromFragment(): { base: string; token: string } | undefined {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const base = fragment.get("localUrl");
  const token = fragment.get("t");
  return base != null && token != null ? { base, token } : undefined;
}

export function SharerApp({ config }: { config: PeerShareConfig }) {
  const [pairing] = useState(pairingFromFragment);
  const [rt] = useState(() => {
    const runtime = createRuntime();
    peershare({
      store: idbSharerStore(),
      bridge: () => pairing,
      mesh: browserMesh({
        relayAddrs: config.relayAddrs,
        invitePage: `${location.origin}/peer-share/invite`,
        dev: config.dev ?? false,
      }),
    }).contribute(runtime);
    return runtime;
  });
  const [diagnosis, setDiagnosis] = useState<BridgeDiagnosis | "checking">();

  const check = async () => {
    if (pairing == null) return;
    setDiagnosis("checking");
    setDiagnosis(await diagnoseBridge({ localUrl: pairing.base, token: pairing.token }));
  };

  useEffect(() => {
    void rt.commands.call(StartSharing, undefined).promise;
    void check();
  }, []);

  return (
    <PeerShareProvider rt={rt}>
      <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        {pairing != null && (
          <BridgeStatus
            permission="prompt"
            {...(diagnosis != null ? { diagnosis } : {})}
            onCheck={check}
          />
        )}
        <SharerScreen />
      </main>
    </PeerShareProvider>
  );
}
