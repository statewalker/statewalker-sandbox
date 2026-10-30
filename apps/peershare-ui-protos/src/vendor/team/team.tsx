import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Avatar,
  AvatarFallback,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@statewalker/ui.view.shadcn";
import { Check, ChevronRight, Copy, Pencil, UserPlus } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import {
  type Device,
  group,
  initials,
  type PendingInvite,
  type Person,
  pendingInvites,
  people,
  type Role,
  today,
} from "../mock.js";

/** Who looks at the Team screen: admins manage it, members only see who is in. */
export type Viewer = "admin" | "member";

export interface TeamProps {
  viewer?: Viewer;
  /** The Sandclaw machine doesn't answer: every change is disabled. */
  offline?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const expiryChoices = [1, 7, 30] as const;

const formatDate = (date: Date) =>
  date.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

const ago = (date: Date) => {
  const days = Math.round((today.getTime() - date.getTime()) / DAY);
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
};

/** The Team screen's state, local to the prototype; each setter stands for a group.core call. */
function useTeamState({ viewer = "admin", offline = false }: TeamProps) {
  const [name, setGroupName] = useState(group.name);
  const [list, setPeople] = useState<Person[]>(() => structuredClone(people));
  const [invites, setInvites] = useState<PendingInvite[]>(() => structuredClone(pendingInvites));
  // The prototype runs on Claire's laptop for admins, on Hugo's for members.
  const meId = viewer === "admin" ? "pk_claire" : "pk_hugo";
  const admins = list.filter((p) => p.role === "admin").length;
  return {
    viewer,
    offline,
    meId,
    name,
    people: list,
    invites,
    /** The only admin can't become a member: nobody could manage the group. */
    isLastAdmin: (p: Person) => p.role === "admin" && admins === 1,
    setGroupName,
    setRole: (personId: string, role: Role) =>
      setPeople((ps) => ps.map((p) => (p.id === personId ? { ...p, role } : p))),
    revokePerson: (personId: string) => setPeople((ps) => ps.filter((p) => p.id !== personId)),
    revokeDevice: (peerId: string) =>
      setPeople((ps) =>
        ps.map((p) => {
          const devices = p.devices?.filter((d) => d.peerId !== peerId);
          return { ...p, devices, online: devices?.some((d) => d.online) ?? false };
        }),
      ),
    invitePerson: ({
      role,
      expiresIn,
      label,
    }: {
      role: Role;
      expiresIn: number;
      label: string;
    }) => {
      const invite: PendingInvite = {
        id: `inv_${invites.length + 1}_${Date.now()}`,
        role,
        label: label || undefined,
        link: `https://app.sandclaw.ai/join#k=${Math.random().toString(36).slice(2, 10)}-${name.toLowerCase().replace(/\W+/g, "-")}`,
        expiresAt: new Date(today.getTime() + expiresIn * DAY),
      };
      setInvites((is) => [...is, invite]);
      return invite;
    },
    cancelInvite: (id: string) => setInvites((is) => is.filter((i) => i.id !== id)),
  };
}

type Team = ReturnType<typeof useTeamState>;
const TeamContext = createContext<Team | null>(null);
const useTeam = () => useContext(TeamContext) as Team;

function Badge({ children }: { children: ReactNode }) {
  return <span className="bg-secondary rounded-md px-2 py-0.5 text-xs">{children}</span>;
}

function Dot({ online }: { online: boolean }) {
  return (
    <span
      title={online ? "Online" : "Offline"}
      className={cn(
        "size-2 shrink-0 rounded-full",
        online ? "bg-success" : "bg-muted-foreground/40",
      )}
    />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

/** A destructive action behind a confirmation that says what will happen. */
function Confirm({
  trigger,
  title,
  children,
  action,
  onConfirm,
  disabled,
}: {
  trigger: string;
  title: string;
  children: ReactNode;
  action: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled}>
          {trigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="grid gap-2">{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 text-white"
            onClick={onConfirm}
          >
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Group name (renamed inline by admins) and the invite button. */
function Header() {
  const team = useTeam();
  const [draft, setDraft] = useState<string | null>(null);
  const isAdmin = team.viewer === "admin";
  const save = () => {
    if (draft?.trim()) team.setGroupName(draft.trim());
    setDraft(null);
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      {draft === null ? (
        <h2 className="flex items-center gap-1 text-xl font-semibold">
          {team.name}
          {isAdmin && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Rename the group"
              disabled={team.offline}
              onClick={() => setDraft(team.name)}
            >
              <Pencil />
            </Button>
          )}
        </h2>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Input
            aria-label="Group name"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setDraft(null)}
            className="w-56"
          />
          <Button size="sm" type="submit">
            Save
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </form>
      )}
      <span className="text-muted-foreground text-sm">
        {team.people.length} {team.people.length === 1 ? "person" : "people"}
      </span>
      {isAdmin && (
        <div className="ml-auto">
          <InviteDialog />
        </div>
      )}
    </div>
  );
}

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; text: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="flex gap-2">
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            size="sm"
            variant={o.value === value ? "default" : "outline"}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.text}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

/** A square standing in for the QR code of the link. */
function QrPlaceholder({ seed }: { seed: string }) {
  const cells = Array.from(
    { length: 81 },
    (_, i) => (seed.charCodeAt(i % seed.length) * (i + 7)) % 3 === 0,
  );
  return (
    <div
      role="img"
      aria-label="QR code"
      className="grid size-28 shrink-0 grid-cols-9 gap-px rounded-md border bg-white p-1.5"
    >
      {cells.map((on, i) => (
        <span key={i} className={on ? "bg-black" : "bg-white"} />
      ))}
    </div>
  );
}

/** Who it is for, role and expiry; then the link to send, with a QR code for phones. */
function InviteDialog() {
  const team = useTeam();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [expiresIn, setExpiresIn] = useState<number>(7);
  const [created, setCreated] = useState<PendingInvite | null>(null);
  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setLabel("");
      setRole("member");
      setExpiresIn(7);
      setCreated(null);
    }
  };
  return (
    <>
      <Button disabled={team.offline} onClick={() => reset(true)}>
        <UserPlus /> Invite someone
      </Button>
      <Dialog open={open} onOpenChange={reset}>
        <DialogContent>
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Send this link{created.label ? ` to ${created.label}` : ""}
                </DialogTitle>
                <DialogDescription>
                  Works once. Expires on {formatDate(created.expiresAt)}.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-start gap-4">
                <div className="grid flex-1 gap-2">
                  <Input aria-label="Invite link" readOnly value={created.link} />
                  <div>
                    <CopyButton text={created.link} />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Anyone who opens it first joins {team.name} as{" "}
                    {created.role === "admin" ? "an admin" : "a member"}. Send it privately.
                  </p>
                </div>
                <QrPlaceholder seed={created.link} />
              </div>
              <DialogFooter>
                <Button onClick={() => reset(false)}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                setCreated(team.invitePerson({ role, expiresIn, label: label.trim() }));
              }}
            >
              <DialogHeader>
                <DialogTitle>Invite someone to {team.name}</DialogTitle>
                <DialogDescription>
                  You get a link to send them. Opening it in a browser is all they need to do.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="invite-label">Who is it for?</Label>
                <Input
                  id="invite-label"
                  placeholder="Paul (accounting)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">Only admins see this note.</p>
              </div>
              <Choice
                label="Role"
                value={role}
                onChange={setRole}
                options={[
                  { value: "member", text: "Member" },
                  { value: "admin", text: "Admin" },
                ]}
              />
              <Choice
                label="Link expires in"
                value={expiresIn}
                onChange={setExpiresIn}
                options={expiryChoices.map((d) => ({
                  value: d,
                  text: d === 1 ? "1 day" : `${d} days`,
                }))}
              />
              <DialogFooter>
                <Button type="submit">Create link</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Claire Morel added a device (Safari on iPhone) · 2 days ago", for the last two weeks. */
function Recent() {
  const team = useTeam();
  if (team.viewer !== "admin") return null;
  const events = team.people
    .flatMap((p) => (p.devices ?? []).map((d) => ({ person: p, device: d })))
    .filter(({ device }) => today.getTime() - device.addedAt.getTime() < 14 * DAY)
    .sort((a, b) => b.device.addedAt.getTime() - a.device.addedAt.getTime());
  if (events.length === 0) return null;
  return (
    <div className="text-muted-foreground grid gap-0.5 text-sm">
      <span className="text-foreground text-xs font-medium uppercase">Recent</span>
      {events.map(({ person, device }) => (
        <span key={device.peerId}>
          {person.name} added a device ({device.label}) · {ago(device.addedAt)}
        </span>
      ))}
    </div>
  );
}

function OfflineNotice() {
  const team = useTeam();
  if (!team.offline) return null;
  return (
    <p className="border-warning/60 rounded-md border p-3 text-sm">
      The Sandclaw machine isn&apos;t answering; changes need it.
    </p>
  );
}

function PersonName({ person }: { person: Person }) {
  const team = useTeam();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar className="size-8">
        <AvatarFallback>{initials(person.name)}</AvatarFallback>
      </Avatar>
      <span className="truncate font-medium">
        {person.name}
        {person.id === team.meId && (
          <span className="text-muted-foreground font-normal"> (you)</span>
        )}
      </span>
      <Dot online={person.online} />
      <Badge>{person.role === "admin" ? "Admin" : "Member"}</Badge>
    </div>
  );
}

/** Change role and remove; why an action is unavailable is said in words, not hidden. */
function PersonActions({ person }: { person: Person }) {
  const team = useTeam();
  if (team.viewer !== "admin") return null;
  const isMe = person.id === team.meId;
  const lastAdmin = team.isLastAdmin(person);
  const first = person.name.split(" ")[0];
  return (
    <div className="grid justify-items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={team.offline || lastAdmin}
          onClick={() => team.setRole(person.id, person.role === "admin" ? "member" : "admin")}
        >
          {person.role === "admin" ? "Make member" : "Make admin"}
        </Button>
        {!isMe && (
          <Confirm
            trigger="Remove"
            title={`Remove ${person.name} from ${team.name}?`}
            action={`Remove ${first}`}
            disabled={team.offline}
            onConfirm={() => team.revokePerson(person.id)}
          >
            <span>
              {person.devices?.length ? "All their devices" : "Their devices"} lose access at once.
            </span>
            <span>
              Files and chats already in their browsers stay there, but can&apos;t reach the
              Sandclaw machine anymore.
            </span>
            <span>To bring {first} back, send a new invite.</span>
          </Confirm>
        )}
      </div>
      {lastAdmin && (
        <span className="text-muted-foreground text-xs">
          The only admin. Make someone else admin first.
        </span>
      )}
      {isMe && !lastAdmin && (
        <span className="text-muted-foreground text-xs">
          You can&apos;t remove yourself; ask another admin.
        </span>
      )}
    </div>
  );
}

function DeviceRow({ person, device }: { person: Person; device: Device }) {
  const team = useTeam();
  return (
    <li className="flex items-center gap-2 text-sm">
      <Dot online={device.online} />
      <span className="flex-1">
        {device.label}
        {device.isThisDevice && <Badge>this device</Badge>}
        <span className="text-muted-foreground"> · added {formatDate(device.addedAt)}</span>
      </span>
      {device.isThisDevice ? (
        <span className="text-muted-foreground text-xs">In use now</span>
      ) : (
        <Confirm
          trigger="Remove device"
          title={`Remove ${device.label} from ${team.name}?`}
          action="Remove device"
          disabled={team.offline}
          onConfirm={() => team.revokeDevice(device.peerId)}
        >
          <span>
            This browser loses access at once. {person.name.split(" ")[0]} keeps their other
            devices.
          </span>
          <span>
            Files and chats already in it stay there, but can&apos;t reach the Sandclaw machine.
          </span>
        </Confirm>
      )}
    </li>
  );
}

function DeviceList({ person }: { person: Person }) {
  const devices = person.devices ?? [];
  if (devices.length === 0)
    return (
      <p className="text-muted-foreground text-sm">
        No devices left. They can&apos;t reach the group.
      </p>
    );
  return (
    <ul className="grid gap-2">
      {devices.map((d) => (
        <DeviceRow key={d.peerId} person={person} device={d} />
      ))}
    </ul>
  );
}

function InviteList() {
  const team = useTeam();
  if (team.invites.length === 0)
    return <p className="text-muted-foreground text-sm">No pending invites.</p>;
  return (
    <ul className="grid gap-2">
      {team.invites.map((invite) => (
        <li
          key={invite.id}
          aria-label={invite.label ?? "Invite"}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="font-medium">{invite.label ?? "Unnamed invite"}</span>
          <Badge>{invite.role === "admin" ? "Admin" : "Member"}</Badge>
          <span className="text-muted-foreground flex-1">
            expires {formatDate(invite.expiresAt)}
          </span>
          <CopyButton text={invite.link} />
          <Button
            size="sm"
            variant="ghost"
            disabled={team.offline}
            onClick={() => team.cancelInvite(invite.id)}
          >
            Cancel invite
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Shell({ props, children }: { props: TeamProps; children: ReactNode }) {
  const team = useTeamState(props);
  return (
    <TeamContext.Provider value={team}>
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4">
        <Header />
        <OfflineNotice />
        <Recent />
        {children}
      </div>
    </TeamContext.Provider>
  );
}

function OneListBody() {
  const team = useTeam();
  const isAdmin = team.viewer === "admin";
  return (
    <>
      <ul className="divide-y rounded-md border">
        {team.people.map((person) => (
          <li key={person.id} aria-label={person.name} className="grid gap-2 p-3">
            <Collapsible>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PersonName person={person} />
                <PersonActions person={person} />
              </div>
              {isAdmin && (
                <>
                  <CollapsibleTrigger asChild>
                    <Button size="sm" variant="link" className="group h-auto px-0">
                      <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                      {person.devices?.length ?? 0}{" "}
                      {person.devices?.length === 1 ? "device" : "devices"}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pt-2 pl-6">
                    <DeviceList person={person} />
                  </CollapsibleContent>
                </>
              )}
            </Collapsible>
          </li>
        ))}
      </ul>
      {isAdmin && (
        <section className="grid gap-2">
          <h3 className="text-sm font-medium">Pending invites</h3>
          <InviteList />
        </section>
      )}
    </>
  );
}

/** A — one list: people with their devices folded under them, pending invites at the bottom. */
export function TeamOneList(props: TeamProps) {
  return (
    <Shell props={props}>
      <OneListBody />
    </Shell>
  );
}

function TwoPanesBody() {
  const team = useTeam();
  const [selectedId, setSelectedId] = useState(team.meId);
  const selected = team.people.find((p) => p.id === selectedId) ?? team.people[0];
  const isAdmin = team.viewer === "admin";
  const peopleList = (
    <ul className="grid content-start gap-1">
      {team.people.map((person) => (
        <li key={person.id} aria-label={person.name}>
          <button
            type="button"
            aria-current={person.id === selected?.id}
            onClick={() => setSelectedId(person.id)}
            className={cn(
              "hover:bg-accent w-full rounded-md p-2 text-left",
              isAdmin && person.id === selected?.id && "bg-accent",
            )}
          >
            <PersonName person={person} />
          </button>
        </li>
      ))}
    </ul>
  );
  if (!isAdmin) return peopleList;
  return (
    <Tabs defaultValue="people">
      <TabsList>
        <TabsTrigger value="people">People ({team.people.length})</TabsTrigger>
        <TabsTrigger value="invites">Pending invites ({team.invites.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="people" className="grid gap-4 md:grid-cols-[16rem_1fr]">
        {peopleList}
        {selected && (
          <section
            aria-label={`${selected.name} details`}
            className="grid content-start gap-4 rounded-md border p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <PersonName person={selected} />
              <PersonActions person={selected} />
            </div>
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">Devices</h3>
              <DeviceList person={selected} />
            </div>
          </section>
        )}
      </TabsContent>
      <TabsContent value="invites">
        <InviteList />
      </TabsContent>
    </Tabs>
  );
}

/** B — two panes: people on the left, the selected person on the right; invites in a tab. */
export function TeamTwoPanes(props: TeamProps) {
  return (
    <Shell props={props}>
      <TwoPanesBody />
    </Shell>
  );
}
