// The link operation as `@statewalker/group.core` exposes it (`LinkFlow`), and a
// scripted driver that moves BOTH devices of one link through its steps, so a
// story can show the keeper's and the mover's screens side by side. Nothing here
// talks to a network: steps advance on timers, failures are injected.

import { type Device, today } from "../mock.js";

/** Link failures end the flow; they are state, not exceptions. */
export type LinkFailure =
  | "expired" // the link window passed 10 minutes
  | "taken" // a second device tried to link: nothing was shared
  | "declined" // someone tapped No / Cancel, or the codes differed
  | "timed-out" // no confirmation on both devices within 2 minutes
  | "other-side-left"; // the other device went away before finishing

export type LinkFlow =
  | { step: "idle" }
  | { step: "window-open"; link: string; qr: string; expiresAt: Date }
  | { step: "exchanging" }
  | { step: "compare"; code: string; side: Side; becomes: string; replaces?: string }
  | { step: "sending" }
  | { step: "done"; device: Device }
  | { step: "failed"; reason: LinkFailure };

/** The keeper's identity is kept; the mover takes it on. */
export type Side = "keeper" | "mover";

/** A6: add a new device to my identity; A7: merge two identities of one human. */
export type LinkCase = "add" | "merge";

export interface Scenario {
  /** The person whose identity is kept. */
  person: string;
  keeperDevice: string;
  moverDevice: string;
  /** Merge only: the mover's own name, which goes away. */
  moverName?: string;
  code: string;
}

export const scenarios: Record<LinkCase, Scenario> = {
  add: {
    person: "Claire Morel",
    keeperDevice: "Firefox on Linux",
    moverDevice: "Safari on iPhone",
    code: "482 193",
  },
  merge: {
    person: "Hugo Benali",
    keeperDevice: "Chrome on Windows",
    moverDevice: "Firefox on macOS",
    moverName: "Hugo B.",
    code: "482 193",
  },
};

/** What the driver injects; expired and timed-out come from the timings. */
export type InjectedFailure = "taken" | "declined" | "other-side-left";

export interface Timings {
  /** Nonce exchange, before the codes show. */
  exchangeMs: number;
  /** The key moving and the Sandclaw machine recording the link. */
  sendMs: number;
  /** How long the link stays valid. */
  windowMs: number;
  /** How long both devices have to confirm the code. */
  confirmMs: number;
}

export const defaultTimings: Timings = {
  exchangeMs: 1200,
  sendMs: 1500,
  windowMs: 10 * 60_000,
  confirmMs: 2 * 60_000,
};

/** Both screens of one link. */
export interface Pair {
  keeper: LinkFlow;
  mover: LinkFlow;
  /** The mover has opened the link (inspected it) but not started linking yet. */
  moverHasLink: boolean;
  confirmed: Record<Side, boolean>;
  /** A device whose tab was closed mid-way. */
  gone?: Side;
}

export const idlePair: Pair = {
  keeper: { step: "idle" },
  mover: { step: "idle" },
  moverHasLink: false,
  confirmed: { keeper: false, mover: false },
};

export const linkUrl = "https://app.sandclaw.ai/link#d=c1-9f2e";

/** The mismatching code shown on the mover when "declined" is injected. */
const wrongCode = "482 139";

export function compareStep(scenario: Scenario, side: Side, fail?: InjectedFailure): LinkFlow {
  const code = side === "mover" && fail === "declined" ? wrongCode : scenario.code;
  return {
    step: "compare",
    code,
    side,
    becomes: scenario.person,
    ...(scenario.moverName ? { replaces: scenario.moverName } : {}),
  };
}

function device(label: string, isThisDevice: boolean): Device {
  return { peerId: "peer_new", label, online: true, isThisDevice, addedAt: today };
}

/** A pair already at the compare step, for stories that start there. */
export function comparePair(linkCase: LinkCase): Pair {
  const scenario = scenarios[linkCase];
  return {
    ...idlePair,
    keeper: compareStep(scenario, "keeper"),
    mover: compareStep(scenario, "mover"),
  };
}

/** A pair already failed, for stories that start there. */
export function failedPair(reason: LinkFailure): Pair {
  const failed: LinkFlow = { step: "failed", reason };
  return reason === "other-side-left"
    ? { ...idlePair, keeper: failed, gone: "mover" }
    : { ...idlePair, keeper: failed, mover: failed };
}

export interface LinkDriver {
  /** Keeper: "Link a device". */
  openWindow(): void;
  /** Mover: scan the QR / open the link. */
  openLink(): void;
  /** Mover: "Link this device". */
  linkWith(): void;
  confirm(side: Side): void;
  /** Variant B: the keeper types the code the mover shows. */
  enterCode(code: string): void;
  /** No, Cancel, Not now. */
  decline(side: Side): void;
  reset(): void;
  dispose(): void;
}

export function createLinkDriver(
  options: { linkCase: LinkCase; fail?: InjectedFailure; start?: Pair } & Timings,
  onChange: (pair: Pair) => void,
): LinkDriver {
  const { linkCase, fail, exchangeMs, sendMs, windowMs, confirmMs } = options;
  const scenario = scenarios[linkCase];
  let pair = options.start ?? idlePair;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const set = (next: Partial<Pair>) => {
    pair = { ...pair, ...next };
    onChange(pair);
  };
  const later = (ms: number, run: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      run();
    }, ms);
    timers.add(t);
  };
  const clear = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  const failBoth = (reason: LinkFailure) => {
    clear();
    set({ keeper: { step: "failed", reason }, mover: { step: "failed", reason } });
  };
  const armConfirm = () =>
    later(confirmMs, () => {
      if (pair.keeper.step === "compare") failBoth("timed-out");
    });
  const toCompare = () => {
    set({
      keeper: compareStep(scenario, "keeper", fail),
      mover: compareStep(scenario, "mover", fail),
      confirmed: { keeper: false, mover: false },
    });
    if (fail === "other-side-left") {
      later(exchangeMs, () => {
        clear();
        set({ keeper: { step: "failed", reason: "other-side-left" }, gone: "mover" });
      });
      return;
    }
    armConfirm();
  };
  const finish = () => {
    clear();
    set({ keeper: { step: "sending" }, mover: { step: "sending" } });
    later(sendMs, () =>
      set({
        keeper: { step: "done", device: device(scenario.moverDevice, false) },
        mover: { step: "done", device: device(scenario.moverDevice, true) },
      }),
    );
  };

  if (pair.keeper.step === "compare") armConfirm();

  return {
    openWindow() {
      const expiresAt = new Date(Date.now() + windowMs);
      set({ keeper: { step: "window-open", link: linkUrl, qr: linkUrl, expiresAt } });
      later(windowMs, () => {
        if (pair.keeper.step !== "window-open") return;
        set({
          keeper: { step: "failed", reason: "expired" },
          ...(pair.moverHasLink ? { mover: { step: "failed", reason: "expired" } } : {}),
        });
      });
    },
    openLink() {
      if (pair.keeper.step === "failed" && pair.keeper.reason === "expired") {
        set({ mover: { step: "failed", reason: "expired" } });
        return;
      }
      set({ moverHasLink: true });
    },
    linkWith() {
      clear();
      set({ keeper: { step: "exchanging" }, mover: { step: "exchanging" }, moverHasLink: false });
      later(exchangeMs, () => (fail === "taken" ? failBoth("taken") : toCompare()));
    },
    confirm(side) {
      if (pair[side].step !== "compare") return;
      const confirmed = { ...pair.confirmed, [side]: true };
      set({ confirmed });
      if (confirmed.keeper && confirmed.mover) {
        // The keeper checks the mover's code before the key moves.
        if (fail === "declined") failBoth("declined");
        else finish();
      }
    },
    enterCode(code) {
      const typed = code.replace(/\D/g, "");
      const shown = pair.mover.step === "compare" ? pair.mover.code.replace(/\D/g, "") : "";
      if (typed === scenario.code.replace(/\D/g, "") && typed === shown) this.confirm("keeper");
      else failBoth("declined");
    },
    decline(side) {
      if (side === "mover" && pair.moverHasLink) {
        // "Not now" before linking: the mover just closes the screen.
        set({ moverHasLink: false });
        return;
      }
      if (pair.keeper.step === "window-open") {
        // Cancelling an open link window: nothing was started.
        clear();
        set(idlePair);
        return;
      }
      failBoth("declined");
    },
    reset() {
      clear();
      set(idlePair);
    },
    dispose: clear,
  };
}

/** "Claire" from "Claire Morel", for short sentences. */
export const firstName = (name: string) => name.split(" ")[0] ?? name;
