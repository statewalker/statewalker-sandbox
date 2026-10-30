/**
 * The views, wired: they read PeerShare's model (`peershare:model`) and act
 * only through its commands. Nothing here knows about the mesh.
 */

import type { CatalogEntry } from "@statewalker/httpeers-share";
import {
  AddService,
  type AppRuntime,
  CloseSession,
  EditService,
  Invite,
  Join,
  ListSharedServices,
  type PeerShareModel,
  type PeerShareSnapshot,
  ProbeService,
  peershareModelSlot,
  RevokeGuest,
  SetName,
  StartSharing,
  StopSharing,
  ToggleService,
} from "@statewalker/peershare";
import type { CommandDeclaration } from "@statewalker/shared-commands";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { GuestJoin, type JoinStage } from "../views/guest-join.js";
import { GuestList } from "../views/guests.js";
import { InviteDialog } from "../views/invite-dialog.js";
import type { Guest, Service } from "../views/model.js";
import { SharerServices } from "../views/sharer-services.js";
import { ViewerFrame, type ViewerService } from "../views/viewer-frame.js";

const Runtime = createContext<AppRuntime | null>(null);

export function PeerShareProvider({ rt, children }: { rt: AppRuntime; children: ReactNode }) {
  return <Runtime.Provider value={rt}>{children}</Runtime.Provider>;
}

function useRuntime(): AppRuntime {
  const rt = useContext(Runtime);
  if (rt == null) throw new Error("PeerShare's views need <PeerShareProvider rt={…}> around them.");
  return rt;
}

/** PeerShare's model, as provided on the runtime's `peershare:model` slot. */
function useModel(): PeerShareModel {
  const rt = useRuntime();
  const [model] = useState(() => {
    let found: PeerShareModel | undefined;
    rt.slots.observe(peershareModelSlot, (values) => {
      found = values[0];
    })();
    if (found == null) throw new Error("PeerShare is not contributed to this runtime.");
    return found;
  });
  return model;
}

export function usePeerShare(): PeerShareSnapshot {
  const model = useModel();
  return useSyncExternalStore(model.subscribe, model.getSnapshot);
}

/** Calls a command. Stable per runtime: effects may depend on it without re-running each render. */
function useCall() {
  const rt = useRuntime();
  return useCallback(
    <P, R>(decl: CommandDeclaration<P, R>, payload: P) => rt.commands.call(decl, payload).promise,
    [rt],
  );
}

/** The logic's Service, as the view draws it. */
function toView(s: PeerShareSnapshot["sharer"]["services"][number]): Service {
  const warnings: Service["warnings"] = [...(s.warnings ?? [])];
  if (s.cause === "cors-missing") warnings.push("cors-missing");
  return {
    id: s.id,
    name: s.name,
    kind: s.kind === "direct" ? "direct" : "bridged",
    target: s.target,
    enabled: s.enabled,
    isDefault: s.isDefault,
    health: s.enabled ? (s.health ?? "checking") : "disabled",
    warnings,
  };
}

export function SharerScreen() {
  const snapshot = usePeerShare();
  const call = useCall();
  const [inviteOpen, setInviteOpen] = useState(false);
  const services = snapshot.sharer.services;

  const guests: Guest[] = snapshot.guests.map((g) => ({
    peerId: g.peerId,
    name: `Guest ${g.peerId.slice(-6)}`,
    joinedAt: new Date(g.joinedAt),
    online: true,
  }));

  return (
    <div className="flex flex-col gap-4">
      <SharerServices
        sharerName={snapshot.sharer.name}
        onSharerNameChange={(name) => void call(SetName, { name })}
        services={services.map(toView)}
        serverOn={snapshot.sharing.sharing}
        onExpose={(draft, kind) => void call(AddService, { ...draft, kind })}
        onEdit={(id, draft, kind) => void call(EditService, { id, draft: { ...draft, kind } })}
        onProbe={(id) => void call(ProbeService, { id })}
        onToggle={(id) => {
          const service = services.find((s) => s.id === id);
          if (service != null) void call(ToggleService, { id, enabled: !service.enabled });
        }}
        onInvite={async () => {
          await call(Invite, undefined);
          setInviteOpen(true);
        }}
        onServer={(on) => void call(on ? StartSharing : StopSharing, undefined)}
      />
      <GuestList guests={guests} onRevoke={(peerId) => void call(RevokeGuest, { peerId })} />
      {snapshot.invite != null && (
        <InviteDialog
          open={inviteOpen}
          invite={{
            url: snapshot.invite.url,
            expiresAt: new Date(snapshot.invite.expiresAt),
            used: false,
          }}
          onClose={() => setInviteOpen(false)}
        />
      )}
    </div>
  );
}

export interface GuestScreenProps {
  /** The invite link this page was opened with. */
  link: string;
  /** The Sharer's name as the link states it, shown before joining. */
  sharerName: string;
  /** What the frame shows for a Service: in the page, its isolated session origin (ADR 0003). */
  frameFor?: (service: ViewerService) => { src?: string; srcDoc?: string };
}

export function GuestScreen({ link, sharerName, frameFor }: GuestScreenProps) {
  const { guest } = usePeerShare();
  const call = useCall();
  const [joining, setJoining] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [selected, setSelected] = useState<string>();

  const joined = guest.stage === "joined" || guest.stage === "machine-offline";
  useEffect(() => {
    if (!joined) return;
    void call(ListSharedServices, undefined).then((entries) => {
      setCatalog(entries);
      setSelected((current) => current ?? entries[0]?.id);
    });
  }, [joined, call]);

  if (!joined) {
    const stage: JoinStage = declined
      ? "declined"
      : joining
        ? "joining"
        : guest.stage === "no-link"
          ? "invite"
          : (guest.stage as JoinStage); // not joined here: see `joined` above
    return (
      <GuestJoin
        sharerName={guest.sharerName ?? sharerName}
        stage={stage}
        onJoin={async () => {
          setJoining(true);
          await call(Join, { link });
          setJoining(false);
        }}
        onDecline={() => setDeclined(true)}
      />
    );
  }

  const services: ViewerService[] = catalog.map((c) => ({
    id: c.id,
    name: c.name,
    paused: c.paused,
  }));
  return (
    <ViewerFrame
      sharerName={guest.sharerName ?? sharerName}
      services={services}
      selected={selected ?? services[0]?.id ?? ""}
      link={guest.stage === "machine-offline" ? "offline" : "connected"}
      onSelect={setSelected}
      onCloseSession={() => void call(CloseSession, undefined)}
      {...(frameFor != null ? { frameFor } : {})}
    />
  );
}
