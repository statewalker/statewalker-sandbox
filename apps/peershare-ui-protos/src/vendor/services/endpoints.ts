import { today } from "../mock.js";

// The services the hub opens to the group's browsers through its reverse proxy
// (A3). One list, whatever the service; raw routes and rules stay in the
// technical console.

/** Who can open the service. */
export type Access = "everyone" | "admins";

/** What the admin sees next to a service. */
export type Health = "ok" | "slow" | "down" | "disabled" | "checking";

/** The last time the hub tried the service. */
export interface Probe {
  at: Date;
  /** How long the service took to answer. */
  ms?: number;
  /** Why it did not answer; present means down. */
  error?: string;
}

export interface Service {
  id: string;
  /** What members see in their menu. */
  name: string;
  /** Where the service runs, as the hub reaches it: `http://192.168.1.20:8000`. */
  target: string;
  /** Where the group opens it, under the hub's address: `/paperless`. */
  path: string;
  access: Access;
  enabled: boolean;
  /** Set for services Sandclaw ships with: why they cannot be removed. */
  builtIn?: string;
  probe?: Probe;
}

/** The fields the admin types when adding or editing a service. */
export type Draft = Pick<Service, "name" | "target" | "path" | "access">;

export type DraftErrors = Partial<Record<"name" | "target" | "path", string>>;

/** An answer slower than this reads as "slow". */
export const SLOW_MS = 1000;

export function healthOf(service: Service, checking: boolean): Health {
  if (!service.enabled) return "disabled";
  if (checking || !service.probe) return "checking";
  if (service.probe.error) return "down";
  return (service.probe.ms ?? 0) > SLOW_MS ? "slow" : "ok";
}

/** "/Paperless/" and "/paperless" are the same address. */
function samePath(a: string, b: string) {
  const norm = (p: string) => p.toLowerCase().replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** Mistakes in a draft, by field; empty when it can be saved. `self` is the service being edited. */
export function validateDraft(draft: Draft, services: Service[], self?: string): DraftErrors {
  const errors: DraftErrors = {};
  const others = services.filter((s) => s.id !== self);

  if (!draft.name.trim()) errors.name = "Give it a name, as members will see it.";

  const path = draft.path.trim();
  const taken = others.find((s) => samePath(s.path, path));
  if (!path.startsWith("/")) errors.path = "Start with /, like /paperless.";
  else if (path.replace(/\/+$/, "") === "")
    errors.path = "/ is Sandclaw itself. Add a name: /paperless.";
  else if (!/^\/[A-Za-z0-9._~\-/]*$/.test(path)) errors.path = "Use only letters, digits, - and /.";
  else if (taken) errors.path = `Already used by ${taken.name}.`;

  let url: URL | undefined;
  try {
    url = new URL(draft.target.trim());
  } catch {}
  if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
    errors.target = "Enter the full address, starting with http:// or https://.";
  }
  return errors;
}

const minutesAgo = (m: number) => new Date(today.getTime() - m * 60_000);

/** The two built-in services, and three the admin added. */
export const services: Service[] = [
  {
    id: "llm-api",
    name: "LLM API",
    target: "http://127.0.0.1:4000",
    path: "/llm/v1",
    access: "everyone",
    enabled: true,
    builtIn: "The assistant reaches its language models through it.",
    probe: { at: minutesAgo(2), ms: 140 },
  },
  {
    id: "llm-ui",
    name: "LiteLLM UI",
    target: "http://127.0.0.1:4000/ui",
    path: "/llm/ui",
    access: "admins",
    enabled: true,
    builtIn: "It comes with the LLM API and shows its models and spending.",
    probe: { at: minutesAgo(2), ms: 210 },
  },
  {
    id: "paperless",
    name: "Documents archive",
    target: "http://192.168.1.20:8000",
    path: "/paperless",
    access: "everyone",
    enabled: true,
    probe: { at: minutesAgo(3), ms: 2400 },
  },
  {
    id: "printer",
    name: "Printer status",
    target: "http://192.168.1.31",
    path: "/printer",
    access: "everyone",
    enabled: true,
    probe: { at: minutesAgo(3), error: "No answer after 10 seconds" },
  },
  {
    id: "wiki",
    name: "Old wiki",
    target: "http://192.168.1.12:3000",
    path: "/wiki",
    access: "admins",
    enabled: false,
    probe: { at: minutesAgo(60 * 24 * 9), ms: 320 },
  },
];

/** What a Test gives for each service in the prototypes; unknown ones answer quickly. */
const testAnswers: Record<string, Omit<Probe, "at">> = {
  paperless: { ms: 1900 },
  printer: { error: "Connection refused" },
};

/** A pretend Test: answers after `delay` ms, as `testAnswers` says. */
export function mockTest(service: Service, now = today, delay = 1500): Promise<Probe> {
  const answer = testAnswers[service.id] ?? { ms: 120 + (service.name.length % 7) * 20 };
  return new Promise((resolve) => setTimeout(() => resolve({ ...answer, at: now }), delay));
}
