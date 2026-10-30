/**
 * A Guest's page: `/peer-share/invite#join=…&from=Dirk`. Each Service opens
 * in its own isolated session origin (ADR 0003), answered over the mesh
 * through PeerShare's `guest-fetch`.
 */

import { decodeInvite } from "@statewalker/httpeers-share";
import {
  createRuntime,
  type GuestFetch,
  type GuestSocket,
  guestFetchSlot,
  guestSocketSlot,
  peershare,
  Resume,
} from "@statewalker/peershare";
import { browserMesh, idbSharerStore } from "@statewalker/peershare/browser";
import { GuestScreen, PeerShareProvider } from "@statewalker/peershare-react";
import { useEffect, useState } from "react";
import type { PeerShareConfig } from "./config.js";
import { listenForSockets, type SessionFrame, withSocketShim } from "./socket-channel.js";
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

  // Live connections (M9): the shim in each session frame asks for sockets here.
  useEffect(() => {
    const frames = () => {
      const byWindow = new Map<MessageEventSource, SessionFrame>();
      for (const iframe of document.querySelectorAll("iframe")) {
        const origin = (() => {
          try {
            return new URL(iframe.src).origin;
          } catch {
            return "";
          }
        })();
        const serviceId = Object.keys(sessions).find(
          (id) => new URL(sessions[id] as string).origin === origin,
        );
        if (serviceId != null && iframe.contentWindow != null)
          byWindow.set(iframe.contentWindow, { serviceId, origin });
      }
      return byWindow;
    };
    return listenForSockets(frames, () => slotValue<GuestSocket>(guestSocketSlot));
  }, [sessions]);

  function slotValue<T>(slot: import("@statewalker/shared-slots").SlotDeclaration<T>): T {
    let value: T | undefined;
    rt.slots.observe(slot, (v) => {
      value = v[0];
    })();
    if (value == null) throw new Error("PeerShare has no mesh");
    return value;
  }

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
          // The WebSocket shim goes first in every page (M9).
          handler: async (request: Request) =>
            withSocketShim(await guestFetch()(service.id, request)),
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
