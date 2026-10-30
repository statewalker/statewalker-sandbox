/**
 * A Guest's page: `/peer-share/invite#join=…&from=Dirk`. Each Service opens
 * in its own isolated session origin (ADR 0003), answered over the mesh
 * through PeerShare's `guest-fetch`.
 */

import { decodeInvite } from "@statewalker/httpeers-share";
import {
  createRuntime,
  type GuestFetch,
  guestFetchSlot,
  peershare,
  Resume,
} from "@statewalker/peershare";
import { browserMesh, idbSharerStore } from "@statewalker/peershare/browser";
import { GuestScreen, PeerShareProvider } from "@statewalker/peershare-react";
import { useEffect, useState } from "react";
import type { PeerShareConfig } from "./config.js";
import { APP_SERVICE_KEY, openSession } from "./vendor/session-shell/client.js";

export function GuestApp({ config }: { config: PeerShareConfig }) {
  const [link] = useState(() => location.href);
  const sharerName = (() => {
    try {
      return decodeInvite(link).sharerName;
    } catch {
      return "Someone";
    }
  })();
  const [rt] = useState(() => {
    const runtime = createRuntime();
    peershare({
      store: idbSharerStore(),
      mesh: browserMesh({
        relayAddrs: config.relayAddrs,
        invitePage: `${location.origin}/peer-share/invite`,
        dev: config.dev ?? false,
      }),
    }).contribute(runtime);
    return runtime;
  });
  const [sessions, setSessions] = useState<Record<string, string>>({});

  useEffect(() => {
    void rt.commands.call(Resume, undefined).promise;
  }, [rt]);

  const guestFetch = (): GuestFetch => {
    let fetcher: GuestFetch | undefined;
    rt.slots.observe(guestFetchSlot, (v) => {
      fetcher = v[0];
    })();
    if (fetcher == null) throw new Error("PeerShare has no mesh");
    return fetcher;
  };

  /** One isolated origin per Service, opened the first time it is shown. */
  const frameFor = (service: { id: string }) => {
    const url = sessions[service.id];
    if (url != null) return { src: url };
    void openSession({
      origin: (name) => config.sessionOrigin.replace("{name}", name),
      services: [
        {
          key: APP_SERVICE_KEY,
          path: "/",
          handler: (request: Request) => guestFetch()(service.id, request),
        },
      ],
    }).then((session) => setSessions((s) => ({ ...s, [service.id]: session.url("/") })));
    return { srcDoc: "<p style='font-family:system-ui;margin:2rem'>Opening…</p>" };
  };

  return (
    <PeerShareProvider rt={rt}>
      <GuestScreen link={link} sharerName={sharerName} frameFor={frameFor} />
    </PeerShareProvider>
  );
}
