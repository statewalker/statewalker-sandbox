import { Button } from "@statewalker/ui.view.shadcn";
import { Link2 } from "lucide-react";
import { type ReactNode, useMemo, useSyncExternalStore } from "react";
import { BridgeStatus } from "../peershare/bridge-status.js";
import { GuestJoin } from "../peershare/guest-join.js";
import { GuestList } from "../peershare/guests.js";
import { InviteDialog } from "../peershare/invite-dialog.js";
import { SharerServices } from "../peershare/sharer-services.js";
import { ViewerFrame } from "../peershare/viewer-frame.js";
import { FakeMesh, type FakeMeshInit } from "./fake-mesh.js";

function Pane({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="grid min-w-0 content-start gap-3">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</h2>
      {children}
    </section>
  );
}

/**
 * Dirk's computer and Claudia's phone, side by side, on one fake mesh. Every
 * screen is the real component; only `FakeMesh` stands in for the network.
 */
export function Scenario(props: FakeMeshInit = {}) {
  const mesh = useMemo(() => new FakeMesh(props), []);
  const { sharer, guest } = useSyncExternalStore(mesh.subscribe, () => mesh.snapshot);

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-2">
      <Pane label="Dirk's computer">
        <BridgeStatus permission="granted" diagnosis={sharer.bridge} onCheck={() => {}} />
        <SharerServices
          sharerName={sharer.name}
          onSharerNameChange={(name) => mesh.call({ id: "peershare:set-name", name })}
          services={sharer.services}
          serverOn={sharer.serverOn}
          onExpose={(draft, kind) => mesh.call({ id: "peershare:add-service", draft, kind })}
          onEdit={(serviceId, draft, kind) =>
            mesh.call({ id: "peershare:edit-service", serviceId, draft, kind })
          }
          onProbe={(serviceId) => mesh.call({ id: "peershare:probe", serviceId })}
          onToggle={(serviceId) => mesh.call({ id: "peershare:toggle-service", serviceId })}
          onInvite={() => mesh.call({ id: "peershare:invite" })}
          onServer={(on) => mesh.call({ id: on ? "peershare:start" : "peershare:stop" })}
        />
        <GuestList
          guests={sharer.guests}
          onRevoke={(peerId) => mesh.call({ id: "peershare:revoke-guest", peerId })}
        />
        {sharer.invite && (
          <InviteDialog
            open={sharer.inviteOpen}
            invite={sharer.invite}
            onClose={() => mesh.call({ id: "peershare:close-invite" })}
          />
        )}
      </Pane>

      <Pane label="Claudia's phone">
        {guest.stage === "no-link" ? (
          <div className="grid gap-2 rounded-md border border-dashed p-4 text-sm">
            <p className="text-muted-foreground">
              {sharer.invite
                ? "Dirk made an invite link. In real life it arrives by chat or as a QR code."
                : "Waiting for Dirk to invite her."}
            </p>
            <div>
              <Button
                variant="outline"
                disabled={sharer.invite == null}
                onClick={() => mesh.call({ id: "scenario:deliver-link" })}
              >
                <Link2 /> Open the link from Dirk
              </Button>
            </div>
          </div>
        ) : guest.stage === "viewing" ? (
          <ViewerFrame
            sharerName={sharer.name}
            services={mesh.guestServices}
            selected={guest.selected ?? ""}
            link={mesh.guestLink}
            revoked={guest.revoked}
            onSelect={(serviceId) => mesh.call({ id: "peershare:open", serviceId })}
            onCloseSession={() => mesh.call({ id: "peershare:close-session" })}
          />
        ) : (
          <GuestJoin
            sharerName={sharer.name}
            stage={guest.stage}
            onJoin={() => mesh.call({ id: "peershare:join" })}
            onDecline={() => mesh.call({ id: "peershare:decline" })}
          />
        )}
      </Pane>
    </div>
  );
}
