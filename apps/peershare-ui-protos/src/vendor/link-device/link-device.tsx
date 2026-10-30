import {
  Avatar,
  AvatarFallback,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  Input,
  Label,
} from "@statewalker/ui.view.shadcn";
import {
  Check,
  Copy,
  FolderOpen,
  Laptop,
  Loader2,
  QrCode,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { group, initials } from "../mock.js";
import {
  createLinkDriver,
  defaultTimings,
  firstName,
  type InjectedFailure,
  idlePair,
  type LinkCase,
  type LinkDriver,
  type LinkFailure,
  type LinkFlow,
  type Pair,
  type Scenario,
  scenarios,
  type Timings,
} from "./flow.js";

/**
 * How the code is checked:
 * - `compare`: both screens show the code, the user taps Yes on both (protocol default);
 * - `type`: the keeper types the code the other device shows; the mover confirms.
 */
export type CodeCheck = "compare" | "type";

export interface LinkDevicesProps extends Partial<Timings> {
  /** A6 adds a new device; A7 merges a second identity of the same person. */
  linkCase?: LinkCase;
  codeCheck?: CodeCheck;
  fail?: InjectedFailure;
  /** Where the story starts; the flow then runs on its own. */
  start?: Pair;
}

/** Both devices of one link, side by side; the reviewer acts on each. */
export function LinkDevices({
  linkCase = "add",
  codeCheck = "compare",
  fail,
  start,
  ...timings
}: LinkDevicesProps) {
  const scenario = scenarios[linkCase];
  const [pair, setPair] = useState<Pair>(start ?? idlePair);
  const t = { ...defaultTimings, ...timings };
  const driver = useMemo(
    () => createLinkDriver({ linkCase, fail, start, ...t }, setPair),
    [linkCase, fail],
  );
  useEffect(() => () => driver.dispose(), [driver]);
  const add = linkCase === "add";

  return (
    <div className="flex min-h-svh w-full flex-wrap items-center justify-center gap-6 p-4">
      <DeviceFrame
        shape="laptop"
        caption={`${firstName(scenario.person)}'s ${add ? "laptop" : "work computer"} · ${scenario.keeperDevice}`}
        keeps
      >
        <KeeperScreen
          flow={pair.keeper}
          confirmed={pair.confirmed.keeper}
          scenario={scenario}
          codeCheck={codeCheck}
          driver={driver}
        />
      </DeviceFrame>
      <DeviceFrame
        shape={add ? "phone" : "laptop"}
        caption={`${add ? "New phone" : "Home laptop, as Hugo B."} · ${scenario.moverDevice}`}
      >
        {pair.gone === "mover" ? (
          <Screen title="This tab was closed" />
        ) : (
          <MoverScreen
            flow={pair.mover}
            hasLink={pair.moverHasLink}
            keeperOpen={
              pair.keeper.step === "window-open" ||
              (pair.keeper.step === "failed" && pair.keeper.reason === "expired")
            }
            confirmed={pair.confirmed.mover}
            scenario={scenario}
            codeCheck={codeCheck}
            add={add}
            driver={driver}
          />
        )}
      </DeviceFrame>
    </div>
  );
}

function DeviceFrame({
  shape,
  caption,
  keeps,
  children,
}: {
  shape: "laptop" | "phone";
  caption: string;
  keeps?: boolean;
  children: ReactNode;
}) {
  const Icon = shape === "phone" ? Smartphone : Laptop;
  return (
    <figure className={cn("grid gap-2", shape === "laptop" && "w-[26rem] max-w-full")}>
      <div
        className={cn(
          "bg-muted/40 overflow-hidden border-4",
          shape === "phone" ? "w-72 rounded-[2rem] pt-5" : "rounded-lg",
        )}
      >
        {shape === "laptop" && (
          <div className="bg-muted flex gap-1.5 px-3 py-2">
            {[0, 1, 2].map((i) => (
              <span key={i} className="bg-muted-foreground/40 size-2 rounded-full" />
            ))}
          </div>
        )}
        <div className="min-h-[26rem] p-3">{children}</div>
      </div>
      <figcaption className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
        <Icon className="size-3.5" /> {caption}
        {keeps && " · identity kept"}
      </figcaption>
    </figure>
  );
}

function Screen({
  title,
  text,
  children,
  footer,
}: {
  title: ReactNode;
  text?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="gap-4 shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {text && <CardDescription>{text}</CardDescription>}
      </CardHeader>
      {children && <CardContent className="grid gap-3">{children}</CardContent>}
      {footer && <CardFooter className="flex-wrap gap-2">{footer}</CardFooter>}
    </Card>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <Screen
      title={
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> {text}
        </span>
      }
    />
  );
}

function BigCode({ code }: { code: string }) {
  return (
    <div className="bg-muted rounded-md py-3 text-center font-mono text-3xl tracking-widest">
      {code}
    </div>
  );
}

/** A stand-in for the QR code: a fixed pattern, not a scannable code. */
function QrPlaceholder() {
  const cells = Array.from({ length: 21 * 21 }, (_, i) => (i * 7919) % 13 < 6);
  return (
    <svg viewBox="0 0 21 21" className="mx-auto size-36" role="img" aria-label="QR code">
      {cells.map((on, i) =>
        on ? <rect key={i} x={i % 21} y={Math.floor(i / 21)} width="1" height="1" /> : null,
      )}
      {[0, 14].flatMap((x) =>
        [0, 14].map((y) =>
          x === 14 && y === 14 ? null : (
            <rect
              key={`${x}-${y}`}
              x={x + 0.5}
              y={y + 0.5}
              width="6"
              height="6"
              fill="var(--background)"
              stroke="currentColor"
            />
          ),
        ),
      )}
    </svg>
  );
}

/** "valid 9:41", counting down to the window's end. */
function Countdown({ expiresAt }: { expiresAt: Date }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((expiresAt.getTime() - now) / 1000));
  return (
    <span>
      valid {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={link} aria-label="Link" className="font-mono text-xs" />
      <Button
        variant="outline"
        size="icon"
        aria-label="Copy link"
        onClick={() => {
          void navigator.clipboard?.writeText(link);
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Plain words per failure and side; every one ends with a next step. */
function failureWords(
  reason: LinkFailure,
  side: "keeper" | "mover",
  scenario: Scenario,
): { title: string; text: string; again: boolean } {
  const nothing = "Nothing was shared.";
  switch (reason) {
    case "expired":
      return side === "keeper"
        ? {
            title: "The link expired",
            text: `A link works for 10 minutes. ${nothing}`,
            again: true,
          }
        : {
            title: "This link has expired",
            text: "Create a new one on your other device.",
            again: false,
          };
    case "taken": {
      const ask =
        firstName(scenario.person) === group.admin
          ? "If it wasn't you, check who else could see the link."
          : `If it wasn't you, tell ${group.admin}.`;
      return side === "keeper"
        ? {
            title: "Someone else tried to use the link",
            text: `A second device opened it, so the link was closed. ${nothing} Start again and open the new link only on your own device. ${ask}`,
            again: true,
          }
        : {
            title: "The link was closed",
            text: `Another device tried to use the same link. ${nothing} Start again on your other device.`,
            again: false,
          };
    }
    case "declined":
      return {
        title: "Not linked",
        text: `Someone tapped No, or the codes were different. ${nothing}`,
        again: side === "keeper",
      };
    case "timed-out":
      return {
        title: "Not linked",
        text: `The code wasn't confirmed on both devices within 2 minutes. ${nothing}`,
        again: side === "keeper",
      };
    case "other-side-left":
      return {
        title: "The other device didn't finish",
        text: `It was closed or lost its connection. ${nothing} Start again with both devices open.`,
        again: side === "keeper",
      };
  }
}

function Failed({
  reason,
  side,
  scenario,
  driver,
}: {
  reason: LinkFailure;
  side: "keeper" | "mover";
  scenario: Scenario;
  driver: LinkDriver;
}) {
  const { title, text, again } = failureWords(reason, side, scenario);
  return (
    <Screen
      title={
        <span className="flex items-center gap-2">
          <TriangleAlert className="text-warning size-4" /> {title}
        </span>
      }
      text={text}
      footer={again && <Button onClick={() => driver.reset()}>Start again</Button>}
    />
  );
}

function KeeperScreen({
  flow,
  confirmed,
  scenario,
  codeCheck,
  driver,
}: {
  flow: LinkFlow;
  confirmed: boolean;
  scenario: Scenario;
  codeCheck: CodeCheck;
  driver: LinkDriver;
}) {
  const [typed, setTyped] = useState("");
  const devices = (extra?: string) => (
    <ul className="grid gap-1 text-sm">
      <li>{scenario.keeperDevice} · this device</li>
      {extra && <li className="font-medium">{extra} · just linked</li>}
    </ul>
  );

  switch (flow.step) {
    case "idle":
      return (
        <Screen
          title="My identity"
          footer={<Button onClick={() => driver.openWindow()}>Link a device</Button>}
        >
          <div className="flex items-center gap-3">
            <Avatar>
              <AvatarFallback>{initials(scenario.person)}</AvatarFallback>
            </Avatar>
            <div className="text-sm font-medium">{scenario.person}</div>
          </div>
          {devices()}
          <p className="text-muted-foreground text-sm">
            Add a new phone or computer, or a device where you already use {group.name} under
            another name.
          </p>
        </Screen>
      );
    case "window-open":
      return (
        <Screen
          title="Link a device"
          text="Open this on your other device or scan it."
          footer={
            <Button variant="outline" onClick={() => driver.decline("keeper")}>
              Cancel
            </Button>
          }
        >
          <QrPlaceholder />
          <CopyLink link={flow.link} />
          <p className="text-muted-foreground flex justify-between text-xs">
            <span>The other device will become {scenario.person}.</span>
            <Countdown expiresAt={flow.expiresAt} />
          </p>
        </Screen>
      );
    case "exchanging":
      return <Busy text="Connecting to your other device…" />;
    case "compare":
      if (confirmed) {
        return (
          <Screen title="Waiting for your other device…" text="Confirm the code there too.">
            <BigCode code={flow.code} />
          </Screen>
        );
      }
      if (codeCheck === "type") {
        return (
          <Screen
            title="Type the code your other device shows"
            text={`It will become ${flow.becomes}.`}
            footer={
              <>
                <Button onClick={() => driver.enterCode(typed)} disabled={typed.length < 6}>
                  Link
                </Button>
                <Button variant="outline" onClick={() => driver.decline("keeper")}>
                  Cancel
                </Button>
              </>
            }
          >
            <Label htmlFor="link-code">Code</Label>
            <Input
              id="link-code"
              inputMode="numeric"
              placeholder="000 000"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="font-mono text-lg tracking-widest"
            />
          </Screen>
        );
      }
      return (
        <Screen
          title="Does your other device show the same code?"
          text={`A device wants to become ${flow.becomes}.`}
          footer={
            <>
              <Button onClick={() => driver.confirm("keeper")}>Yes, it&apos;s the same code</Button>
              <Button variant="outline" onClick={() => driver.decline("keeper")}>
                No
              </Button>
            </>
          }
        >
          <BigCode code={flow.code} />
        </Screen>
      );
    case "sending":
      return <Busy text="Linking…" />;
    case "done":
      return (
        <Screen
          title={`${flow.device.label} is now one of your devices`}
          text={
            scenario.moverName
              ? `${scenario.moverName} is now ${scenario.person}: one person in ${group.name}.`
              : undefined
          }
        >
          {devices(flow.device.label)}
        </Screen>
      );
    case "failed":
      return <Failed reason={flow.reason} side="keeper" scenario={scenario} driver={driver} />;
  }
}

function MoverScreen({
  flow,
  hasLink,
  keeperOpen,
  confirmed,
  scenario,
  codeCheck,
  add,
  driver,
}: {
  flow: LinkFlow;
  hasLink: boolean;
  keeperOpen: boolean;
  confirmed: boolean;
  scenario: Scenario;
  codeCheck: CodeCheck;
  add: boolean;
  driver: LinkDriver;
}) {
  const [opening, setOpening] = useState(false);
  const who = scenario.person;
  const stays = "Files and chats on this device stay.";

  switch (flow.step) {
    case "idle":
    case "window-open":
      if (hasLink) {
        return add ? (
          <Screen
            title={`${who} wants to link this device`}
            text={`This phone will become ${who}'s, in ${group.name}. Nothing is shared until you check a code on both devices.`}
            footer={
              <>
                <Button onClick={() => driver.linkWith()}>Link this device</Button>
                <Button variant="ghost" onClick={() => driver.decline("mover")}>
                  Not now
                </Button>
              </>
            }
          />
        ) : (
          <Screen
            title={`Link this device to ${who}?`}
            text={`On this device you are ${scenario.moverName} in ${group.name}. After linking you'll be ${who} here too: one person, one name.`}
            footer={
              <>
                <Button onClick={() => driver.linkWith()}>Link this device</Button>
                <Button variant="ghost" onClick={() => driver.decline("mover")}>
                  Not now
                </Button>
              </>
            }
          >
            <p className="text-sm">{stays}</p>
          </Screen>
        );
      }
      return (
        <Screen
          title={add ? "Camera" : `${group.name} · ${scenario.moverName}`}
          text={
            keeperOpen
              ? add
                ? "Point the camera at the code on your other device."
                : "Open the link from your other device."
              : "Nothing to open yet: start with “Link a device” on the other device."
          }
          footer={
            <Button disabled={!keeperOpen} onClick={() => driver.openLink()}>
              <QrCode /> {add ? "Scan the code" : "Open the link"}
            </Button>
          }
        />
      );
    case "exchanging":
      return <Busy text={`Connecting to ${firstName(who)}'s other device…`} />;
    case "compare": {
      const what = flow.replaces
        ? `${flow.replaces} will become ${flow.becomes}; ${stays.toLowerCase()}`
        : `This device will become ${flow.becomes}'s.`;
      if (confirmed) {
        return (
          <Screen title="Waiting for your other device…" text="Confirm the code there too.">
            <BigCode code={flow.code} />
          </Screen>
        );
      }
      return (
        <Screen
          title={
            codeCheck === "type"
              ? "Type this code on your other device"
              : "Does your other device show the same code?"
          }
          text={what}
          footer={
            <>
              <Button onClick={() => driver.confirm("mover")}>
                {codeCheck === "type" ? "Confirm" : "Yes, it's the same code"}
              </Button>
              <Button variant="outline" onClick={() => driver.decline("mover")}>
                {codeCheck === "type" ? "Cancel" : "No"}
              </Button>
            </>
          }
        >
          <BigCode code={flow.code} />
        </Screen>
      );
    }
    case "sending":
      return <Busy text="Linking…" />;
    case "done":
      return add ? (
        <Screen
          title={`This phone is now ${who}'s`}
          text="Choose the folder the assistant works with on this device."
        >
          <Button disabled={opening} onClick={() => setOpening(true)}>
            {opening ? <Loader2 className="animate-spin" /> : <FolderOpen />} Open a folder
          </Button>
          <Button variant="outline" disabled={opening} onClick={() => setOpening(true)}>
            Start with an empty folder in this browser
          </Button>
        </Screen>
      ) : (
        <Screen title={`You're ${who} on this device too`} text={stays}>
          <p className="text-muted-foreground text-sm">
            {scenario.moverName} no longer appears in {group.name}.
          </p>
        </Screen>
      );
    case "failed":
      return <Failed reason={flow.reason} side="mover" scenario={scenario} driver={driver} />;
  }
}
