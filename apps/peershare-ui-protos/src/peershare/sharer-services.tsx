import { Button, Card, cn, Input, Label } from "@statewalker/ui.view.shadcn";
import { Pencil, Plus, Power, RefreshCw, Star, UserPlus } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  type DraftCheck,
  type Health,
  type Service,
  type ServiceDraft,
  type UpstreamKind,
  validateDraft,
  type Warning,
} from "../model.js";
import { Field, HealthTag } from "../vendor/services/services.js";

/**
 * The Sharer's page: who is sharing, what is shared, and the two actions that
 * matter — invite a guest, turn the server off. Controlled: every change is a
 * callback; the parent (or the scenario's fake mesh) owns the list.
 */
export interface SharerServicesProps {
  sharerName: string;
  onSharerNameChange?: (name: string) => void;
  services: Service[];
  /** False after "Turn off server": guests see the Sharer offline. */
  serverOn?: boolean;
  /** Opens the add form even when services exist (story states). */
  adding?: boolean;
  onExpose: (draft: ServiceDraft, kind: UpstreamKind) => void;
  onEdit?: (id: string, draft: ServiceDraft, kind: UpstreamKind) => void;
  onProbe: (id: string) => void;
  onToggle: (id: string) => void;
  onInvite: () => void;
  onServer?: (on: boolean) => void;
}

const warningWords: Record<Warning, string> = {
  "ws-needed":
    "It uses WebSockets (live reload, chat…). Pages load for guests, but those parts stay still.",
  "cookies-set": "It signs people in with cookies. Guests may have to sign in again on every page.",
  "cors-missing":
    "It does not let the PeerShare page call it (no CORS headers). Allow https://tools.sandclaw.ai in its settings, or run it on this computer and share it through the Bridge.",
};

const kindWords: Record<UpstreamKind, string> = {
  bridged: "through the Bridge on this computer",
  direct: "directly",
};

/** What the Sharer can do about a service that is down, slow or off. */
function Advice({ service }: { service: Service }) {
  const text: Partial<Record<Health, ReactNode>> = {
    down:
      service.kind === "bridged"
        ? "PeerShare cannot reach it. Check that it is running on this computer and that the Bridge is still open, then test again."
        : "PeerShare cannot reach it. Check the address and that the service is online, then test again.",
    slow: "It answers, but slowly. Guests will wait for its pages.",
    disabled: "Turned off: guests see a “paused” page instead. Turn it on again any time.",
  };
  const said = text[service.health];
  if (said == null && service.warnings.length === 0) return null;
  return (
    <div
      className={cn(
        "grid gap-1 rounded-md border p-3 text-sm",
        service.health === "down" && "border-destructive/50 bg-destructive/5",
        service.health === "slow" && "border-warning/60 bg-warning/10",
      )}
    >
      {said != null && <p>{said}</p>}
      {service.warnings.map((w) => (
        <p key={w} className="text-muted-foreground">
          {warningWords[w]}
        </p>
      ))}
    </div>
  );
}

const emptyDraft: ServiceDraft = { name: "", target: "", isDefault: true };

function ExposeForm({
  initial,
  self,
  services,
  submitText,
  onSubmit,
  onCancel,
}: {
  initial: ServiceDraft;
  self?: Service;
  services: Service[];
  submitText: string;
  onSubmit: (draft: ServiceDraft, kind: UpstreamKind) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [check, setCheck] = useState<DraftCheck | undefined>();
  const errors = check != null && !check.ok ? check.errors : {};
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const result = validateDraft(draft, services, self?.id);
        setCheck(result);
        if (result.ok) onSubmit({ ...draft, name: draft.name.trim() }, result.kind);
      }}
    >
      <Field id="share-name" label="Name" hint="What your guests see." error={errors.name}>
        <Input
          id="share-name"
          value={draft.name}
          placeholder="fooService"
          aria-invalid={Boolean(errors.name)}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </Field>
      <Field
        id="share-target"
        label="Local URL to expose"
        hint="A service on this computer (through the Bridge), or a remote https:// address that allows calls from PeerShare."
        error={errors.target}
      >
        <Input
          id="share-target"
          value={draft.target}
          placeholder="http://localhost:5173"
          className="font-mono"
          aria-invalid={Boolean(errors.target)}
          onChange={(e) => setDraft({ ...draft, target: e.target.value })}
        />
      </Field>
      <Label className="flex items-center gap-2 font-normal">
        <input
          type="checkbox"
          checked={draft.isDefault}
          onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
        />
        The default service (guests see it first)
      </Label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={draft.target.trim() === ""}>
          {submitText}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function ServiceRow({
  service,
  onProbe,
  onToggle,
  onEdit,
}: {
  service: Service;
  onProbe: () => void;
  onToggle: () => void;
  onEdit: () => void;
}) {
  return (
    <li className="grid gap-3 border-b p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium">{service.name}</span>
        <HealthTag health={service.health} />
        {service.isDefault && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <Star className="size-3" /> default
          </span>
        )}
      </div>
      <p className="text-muted-foreground min-w-0 text-sm break-all">
        exposing <span className="text-foreground font-mono">{service.target}</span>{" "}
        {kindWords[service.kind]}
      </p>
      <Advice service={service} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onProbe}
          disabled={service.health === "checking" || !service.enabled}
        >
          <RefreshCw /> Test again
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
        <Button size="sm" variant="outline" onClick={onToggle}>
          <Power /> {service.enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
    </li>
  );
}

export function SharerServices({
  sharerName,
  onSharerNameChange,
  services,
  serverOn = true,
  adding = false,
  onExpose,
  onEdit,
  onProbe,
  onToggle,
  onInvite,
  onServer,
}: SharerServicesProps) {
  const [formOpen, setFormOpen] = useState(adding);
  const [editing, setEditing] = useState<string | undefined>();
  const showForm = services.length === 0 || formOpen;
  const canInvite = serverOn && services.some((s) => s.enabled);

  return (
    <Card className="w-full max-w-2xl gap-0 py-0">
      <div className="grid gap-1 border-b p-4">
        <h2 className="flex flex-wrap items-center gap-2 font-semibold">
          Services of
          <Input
            aria-label="Your name"
            value={sharerName}
            placeholder="enter your name"
            className="h-8 w-40"
            onChange={(e) => onSharerNameChange?.(e.target.value)}
          />
        </h2>
        <p className="text-muted-foreground text-sm">What you open to your guests' browsers.</p>
      </div>

      {!serverOn && (
        <p className="border-warning/60 bg-warning/10 border-b p-4 text-sm">
          The server is off. Guests see you as offline until you turn it on again.
        </p>
      )}

      <ul>
        {services.map((service) =>
          editing === service.id ? (
            <li key={service.id} className="border-b p-4">
              <ExposeForm
                initial={{
                  name: service.name,
                  target: service.target,
                  isDefault: service.isDefault,
                }}
                self={service}
                services={services}
                submitText="Save"
                onCancel={() => setEditing(undefined)}
                onSubmit={(draft, kind) => {
                  onEdit?.(service.id, draft, kind);
                  setEditing(undefined);
                }}
              />
            </li>
          ) : (
            <ServiceRow
              key={service.id}
              service={service}
              onProbe={() => onProbe(service.id)}
              onToggle={() => onToggle(service.id)}
              onEdit={() => setEditing(service.id)}
            />
          ),
        )}
      </ul>

      {showForm ? (
        <div className="border-b p-4">
          <ExposeForm
            initial={{ ...emptyDraft, isDefault: services.length === 0 }}
            services={services}
            submitText="Expose service"
            onCancel={services.length > 0 ? () => setFormOpen(false) : undefined}
            onSubmit={(draft, kind) => {
              onExpose(draft, kind);
              setFormOpen(false);
            }}
          />
        </div>
      ) : (
        <div className="flex justify-end border-b p-4">
          <Button variant="outline" onClick={() => setFormOpen(true)}>
            <Plus /> Add another service
          </Button>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2 p-4">
        <Button onClick={onInvite} disabled={!canInvite}>
          <UserPlus /> Invite Guest User
        </Button>
        <Button variant="outline" onClick={() => onServer?.(!serverOn)}>
          <Power /> {serverOn ? "Turn off server" : "Turn on server"}
        </Button>
      </div>
    </Card>
  );
}
