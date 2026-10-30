import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Card,
  cn,
  Input,
  Label,
} from "@statewalker/ui.view.shadcn";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { today } from "../mock.js";
import {
  type Access,
  type Draft,
  type Health,
  healthOf,
  services as mockServices,
  mockTest,
  type Probe,
  type Service,
  validateDraft,
} from "./endpoints.js";

/**
 * How the admin manages the hub's services:
 * - `inline`: one list; a row opens in place to its details and edit form;
 * - `list-detail`: the list on one side, the chosen service on the other (stacked on a phone).
 */
export type ServicesVariant = "inline" | "list-detail";

export interface ServicesProps {
  variant?: ServicesVariant;
  services?: Service[];
  /** The service opened (A) or chosen (B) at first. */
  selected?: string;
  /** Opens the add form with these values, mistakes shown. */
  draft?: Draft;
  /** A Test of this service starts when the panel opens. */
  testing?: string;
  /** Opens the remove confirmation for this service. */
  removing?: string;
  /** Tries a service; a pretend one by default. */
  test?: (service: Service) => Promise<Probe>;
  /** "Now"; `today` from the mock by default. */
  now?: Date;
}

const healthWords: Record<Health, string> = {
  ok: "Working",
  slow: "Slow",
  down: "Not reachable",
  disabled: "Off",
  checking: "Testing…",
};

const healthDot: Record<Health, string> = {
  ok: "bg-success",
  slow: "bg-warning",
  down: "bg-destructive",
  disabled: "bg-muted-foreground",
  checking: "bg-primary animate-pulse",
};

const accessWords: Record<Access, string> = { everyone: "Everyone", admins: "Admins only" };

function HealthTag({ health }: { health: Health }) {
  return (
    <span className="bg-secondary inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs">
      <span className={cn("size-2 rounded-full", healthDot[health])} />
      {healthWords[health]}
    </span>
  );
}

/** "140 ms", "1.9 s". */
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/** "just now", "3 min ago", "9 days ago". */
function ago(at: Date, now: Date) {
  const min = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 60 / 24)} days ago`;
}

function lastTest(service: Service, health: Health, now: Date) {
  const { probe } = service;
  if (health === "checking") return "Testing now…";
  if (!probe) return "Not tested yet";
  const when = ago(probe.at, now);
  return probe.error
    ? `No answer: ${probe.error} · ${when}`
    : `Answered in ${duration(probe.ms ?? 0)} · ${when}`;
}

/** What the admin can do about a service that is down, slow or off. */
function Advice({ service, health }: { service: Service; health: Health }) {
  const host = URL.canParse(service.target) ? new URL(service.target).host : service.target;
  let title = "";
  let text: ReactNode = null;
  if (health === "down" && service.builtIn) {
    title = "Sandclaw cannot reach it";
    text =
      "It runs on the hub itself, so restarting the hub usually brings it back. Until then the assistant cannot answer anyone.";
  } else if (health === "down") {
    title = "Sandclaw cannot reach it";
    text = (
      <>
        Check that the machine at <span className="font-mono">{host}</span> is on and connected to
        the office network, then test again. If its address changed, edit it. Meanwhile members who
        open it get a “not available” page; turn it off to take it out of their menu.
      </>
    );
  } else if (health === "slow") {
    title = "It answers, but slowly";
    text =
      "Members will wait for its pages. The machine running it may be busy; if it stays slow, check it there.";
  } else if (health === "disabled") {
    title = "Turned off";
    text = `Members don't see it in their menu and its address answers “not available”. Nothing is deleted; turn it on again any time.${
      service.id === "llm-api" ? " The assistant cannot answer while this is off." : ""
    }`;
  }
  if (!title) return null;
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm",
        health === "down" && "border-destructive/50 bg-destructive/5",
        health === "slow" && "border-warning/60 bg-warning/10",
      )}
    >
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground mt-1">{text}</p>
    </div>
  );
}

interface Actions {
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}

function ServiceDetail({
  service,
  health,
  now,
  onTest,
  onEdit,
  onToggle,
  onRemove,
}: { service: Service; health: Health; now: Date } & Actions) {
  return (
    <div className="grid gap-3">
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Address in Sandclaw</dt>
        <dd className="font-mono break-all">{service.path}</dd>
        <dt className="text-muted-foreground">Who can use it</dt>
        <dd>{accessWords[service.access]}</dd>
        <dt className="text-muted-foreground">Where it runs</dt>
        <dd className="text-muted-foreground font-mono text-xs break-all sm:text-sm">
          {service.target}
        </dd>
        <dt className="text-muted-foreground">Last test</dt>
        <dd>{lastTest(service, health, now)}</dd>
      </dl>
      <Advice service={service} health={health} />
      {service.builtIn && (
        <p className="text-muted-foreground text-xs">
          Comes with Sandclaw: it can be turned off, not removed. {service.builtIn}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onTest}
          disabled={health === "checking" || health === "disabled"}
        >
          <RefreshCw /> {service.probe ? "Test again" : "Test"}
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil /> Edit
        </Button>
        <Button size="sm" variant="outline" onClick={onToggle}>
          <Power /> {service.enabled ? "Turn off" : "Turn on"}
        </Button>
        {!service.builtIn && (
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onRemove}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {error}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">{hint}</p>
      )}
    </div>
  );
}

const emptyDraft: Draft = { name: "", path: "/", target: "http://", access: "everyone" };

/** Adds a service (no `self`) or edits one. Mistakes show once the admin tries to save. */
function ServiceForm({
  initial,
  self,
  services,
  showErrors = false,
  onSave,
  onCancel,
}: {
  initial: Draft;
  self?: Service;
  services: Service[];
  showErrors?: boolean;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(showErrors);
  const errors = tried ? validateDraft(draft, services, self?.id) : {};
  const set = (field: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft({ ...draft, [field]: e.target.value });
  const input = (field: "name" | "path" | "target") => ({
    id: `service-${field}`,
    value: draft[field],
    onChange: set(field),
    "aria-invalid": Boolean(errors[field]),
    "aria-describedby": errors[field] ? `service-${field}-error` : undefined,
  });
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (Object.keys(validateDraft(draft, services, self?.id)).length === 0) onSave(draft);
      }}
    >
      <h3 className="font-medium">{self ? `Edit ${self.name}` : "Add a service"}</h3>
      <Field
        id="service-name"
        label="Name"
        hint="What members see in their menu."
        error={errors.name}
      >
        <Input {...input("name")} placeholder="Documents archive" />
      </Field>
      <Field
        id="service-path"
        label="Address in Sandclaw"
        hint={
          self?.builtIn
            ? "Fixed: the assistant relies on this address."
            : "Members open it at this address, after Sandclaw's own."
        }
        error={errors.path}
      >
        <Input
          {...input("path")}
          placeholder="/paperless"
          className="font-mono"
          disabled={Boolean(self?.builtIn)}
        />
      </Field>
      <Field
        id="service-target"
        label="Where it runs"
        hint="The service's own address on your network, as the hub reaches it."
        error={errors.target}
      >
        <Input {...input("target")} placeholder="http://192.168.1.20:8000" className="font-mono" />
      </Field>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Who can use it</legend>
        <div className="flex flex-wrap gap-2">
          {(["everyone", "admins"] as const).map((a) => (
            <Button
              key={a}
              type="button"
              size="sm"
              variant={draft.access === a ? "default" : "outline"}
              aria-pressed={draft.access === a}
              onClick={() => setDraft({ ...draft, access: a })}
            >
              {accessWords[a]}
            </Button>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{self ? "Save" : "Add and test"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Name, health, and the address and audience in one line under it. */
function Summary({ service, health }: { service: Service; health: Health }) {
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{service.name}</span>
        <HealthTag health={health} />
      </span>
      <span className="text-muted-foreground min-w-0 truncate text-xs">
        <span className="font-mono">{service.path}</span> · {accessWords[service.access]}
      </span>
    </span>
  );
}

export function Services({
  variant = "inline",
  services: initialServices = mockServices,
  selected,
  draft,
  testing,
  removing: initialRemoving,
  test,
  now = today,
}: ServicesProps) {
  const [list, setList] = useState(initialServices);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<string | undefined>(
    selected ?? (variant === "list-detail" ? initialServices[0]?.id : undefined),
  );
  const [editing, setEditing] = useState<string | undefined>(draft ? "new" : undefined);
  const [removing, setRemoving] = useState(initialRemoving);

  const runTest = (service: Service) => {
    setChecking((c) => new Set(c).add(service.id));
    (test ?? ((s: Service) => mockTest(s, now)))(service).then((probe) => {
      setList((l) => l.map((s) => (s.id === service.id ? { ...s, probe } : s)));
      setChecking((c) => new Set([...c].filter((id) => id !== service.id)));
    });
  };

  useEffect(() => {
    const service = list.find((s) => s.id === testing);
    if (service) runTest(service);
  }, []);

  const update = (id: string, change: Partial<Service>) =>
    setList((l) => l.map((s) => (s.id === id ? { ...s, ...change } : s)));

  const save = (value: Draft, self?: Service) => {
    const clean = { ...value, name: value.name.trim(), path: value.path.trim() };
    if (self) {
      const changed = { ...self, ...clean };
      update(self.id, clean);
      if (self.target !== changed.target && changed.enabled) runTest(changed);
    } else {
      const added: Service = { ...clean, id: crypto.randomUUID(), enabled: true };
      setList((l) => [...l, added]);
      setOpen(added.id);
      runTest(added);
    }
    setEditing(undefined);
  };

  const actions = (service: Service): Actions => ({
    onTest: () => runTest(service),
    onEdit: () => setEditing(service.id),
    onToggle: () => {
      update(service.id, { enabled: !service.enabled });
      if (!service.enabled) runTest(service);
    },
    onRemove: () => setRemoving(service.id),
  });

  const health = (s: Service) => healthOf(s, checking.has(s.id));

  const form = (self?: Service) => (
    <ServiceForm
      key={self?.id ?? "new"}
      initial={self ?? draft ?? emptyDraft}
      self={self}
      services={list}
      showErrors={!self && Boolean(draft)}
      onSave={(value) => save(value, self)}
      onCancel={() => setEditing(undefined)}
    />
  );

  const body = (service: Service) =>
    editing === service.id ? (
      form(service)
    ) : (
      <ServiceDetail service={service} health={health(service)} now={now} {...actions(service)} />
    );

  const toRemove = list.find((s) => s.id === removing && !s.builtIn);
  const chosen = list.find((s) => s.id === open);

  return (
    <Card className={cn("w-full gap-0 py-0", variant === "inline" ? "max-w-2xl" : "max-w-4xl")}>
      <div className="flex flex-wrap items-center gap-2 border-b p-4">
        <div className="mr-auto min-w-0">
          <h2 className="font-semibold">Services</h2>
          <p className="text-muted-foreground text-sm">
            What Sandclaw opens to the group's browsers.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditing("new");
            if (variant === "inline") setOpen(undefined);
          }}
          disabled={editing === "new"}
        >
          <Plus /> Add a service
        </Button>
      </div>

      {variant === "inline" ? (
        <ul>
          {editing === "new" && <li className="border-b p-4">{form()}</li>}
          {list.map((service) => {
            const isOpen = open === service.id;
            return (
              <li key={service.id} className="border-b">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => {
                    setOpen(isOpen ? undefined : service.id);
                    if (editing !== "new") setEditing(undefined);
                  }}
                  className={cn(
                    "hover:bg-accent flex w-full items-start gap-3 px-4 py-3 text-left",
                    !service.enabled && "text-muted-foreground",
                  )}
                >
                  {isOpen ? (
                    <ChevronDown className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  ) : (
                    <ChevronRight className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  )}
                  <Summary service={service} health={health(service)} />
                </button>
                {isOpen && <div className="px-4 pb-4 sm:pl-11">{body(service)}</div>}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="grid md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <ul className="border-b md:border-r md:border-b-0">
            {list.map((service) => (
              <li key={service.id}>
                <button
                  type="button"
                  aria-current={open === service.id && editing !== "new"}
                  onClick={() => {
                    setOpen(service.id);
                    setEditing(undefined);
                  }}
                  className={cn(
                    "hover:bg-accent flex w-full px-4 py-3 text-left",
                    open === service.id && editing !== "new" && "bg-accent",
                    !service.enabled && "text-muted-foreground",
                  )}
                >
                  <Summary service={service} health={health(service)} />
                </button>
              </li>
            ))}
          </ul>
          <section aria-label="Service details" className="min-w-0 p-4">
            {editing === "new" ? (
              form()
            ) : chosen ? (
              <div className="grid gap-3">
                {editing !== chosen.id && (
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="min-w-0 truncate font-medium">{chosen.name}</h3>
                    <HealthTag health={health(chosen)} />
                  </div>
                )}
                {body(chosen)}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Choose a service to see its details.</p>
            )}
          </section>
        </div>
      )}

      <p className="text-muted-foreground p-4 text-xs">
        Routes, headers and rewrite rules are in the{" "}
        <a href="#technical-console" className="inline-flex items-center gap-1 underline">
          technical console <ExternalLink className="size-3" />
        </a>{" "}
        (Advanced routing).
      </p>

      <AlertDialog open={Boolean(toRemove)} onOpenChange={(o) => !o && setRemoving(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {toRemove?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                <p>
                  It leaves members' menus and <span className="font-mono">{toRemove?.path}</span>{" "}
                  stops opening it. The service itself keeps running at its own address; only
                  Sandclaw stops showing it.
                </p>
                <p>To keep its settings for later, turn it off instead.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => {
                setList((l) => l.filter((s) => s.id !== toRemove?.id));
                if (open === toRemove?.id) setOpen(undefined);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
