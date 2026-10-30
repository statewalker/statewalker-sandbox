/**
 * The v1 target policy: a local service goes through the Bridge (the CORS
 * proxy on localhost); a remote one must be https, on a domain name, and send
 * CORS headers itself (that last part only a probe can tell).
 */

import { describe, expect, it } from "vitest";
import { type Service, validateDraft } from "../src/views/model.js";

const existing: Service[] = [
  {
    id: "wiki",
    name: "Team wiki",
    kind: "bridged",
    target: "http://localhost:3000",
    enabled: true,
    isDefault: true,
    health: "ok",
    warnings: [],
  },
];

const draft = (target: string, name = "fooService") => ({ name, target, isDefault: false });

describe("validateDraft — which way a Service is reached", () => {
  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:9000/app",
    "http://[::1]:8000",
    "https://localhost:8443",
    "http://192.168.1.20:8000",
    "http://10.0.0.5",
    "http://100.101.102.103:8080",
    "http://nas.local:5000",
  ])("%s → through the Bridge", (target) => {
    expect(validateDraft(draft(target), existing)).toEqual({ ok: true, kind: "bridged", target });
  });

  it.each(["https://docs.example.com", "https://api.example.org:8443/v1"])(
    "%s → directly (https, a domain name)",
    (target) => {
      expect(validateDraft(draft(target), existing)).toEqual({ ok: true, kind: "direct", target });
    },
  );

  it.each([
    ["http://docs.example.com", "A remote service must use https://."],
    ["https://93.184.216.34", "Use the service's domain name, not an IP address."],
    ["http://8.8.8.8", "Use the service's domain name, not an IP address."],
    ["http://0.0.0.0:3000", "Use localhost or the machine's own address, not 0.0.0.0."],
    ["ftp://files.example.com", "Start the address with http:// or https://."],
    ["localhost:5173", "Start the address with http:// or https://."],
    ["", "Enter the service's address."],
  ])("%s → refused: %s", (target, message) => {
    expect(validateDraft(draft(target), existing)).toEqual({
      ok: false,
      errors: { target: message },
    });
  });
});

describe("validateDraft — the name", () => {
  it("needs one", () => {
    expect(validateDraft(draft("http://localhost:1", "  "), existing)).toEqual({
      ok: false,
      errors: { name: "Give it a name guests will recognise." },
    });
  });

  it("must differ from the other Services' names, ignoring case", () => {
    expect(validateDraft(draft("http://localhost:1", "team WIKI"), existing)).toEqual({
      ok: false,
      errors: { name: "Another service is already called that." },
    });
  });

  it("may keep its own name when edited", () => {
    expect(validateDraft(draft("http://localhost:1", "Team wiki"), existing, "wiki")).toMatchObject(
      {
        ok: true,
      },
    );
  });
});
