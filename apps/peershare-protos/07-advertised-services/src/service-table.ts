/**
 * The Sharer's Services as Guests see them: a live catalog at `/s/`, and
 * each Service at `/s/<id>/…`.
 *
 * The hub's own advertisements are posted once, when it is created (there is
 * no way to update them), so they cannot carry a Service that was added or
 * paused later. One static advertisement says "Dirk shares services"; what
 * they are, and which are paused, is read here, per request.
 */

import type { FetchHandler, Upstream } from "@statewalker/webrun-http-proxy";
import { shareRouter } from "../../01-upstream-kinds/src/share-router.js";

export interface ServiceEntry {
  id: string;
  name: string;
  upstream: Upstream;
  enabled: boolean;
  isDefault: boolean;
}

export interface CatalogEntry {
  id: string;
  name: string;
  isDefault: boolean;
  paused: boolean;
}

/** Marks the table's own answers (paused, unknown), so they are never taken for a Service's. */
export const SERVICE_MARKER = "x-peershare-service";

export function serviceTable(
  services: () => readonly ServiceEntry[],
  opts: { sharerName?: string } = {},
): FetchHandler {
  const sharer = opts.sharerName ?? "The Sharer";
  const router = shareRouter({ services: () => services().filter((s) => s.enabled) });

  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/s/" || pathname === "/s") {
      const catalog: CatalogEntry[] = [...services()]
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
        .map((s) => ({ id: s.id, name: s.name, isDefault: s.isDefault, paused: !s.enabled }));
      return Response.json(catalog);
    }
    const id = pathname.split("/")[2] ?? "";
    const service = services().find((s) => s.id === id);
    if (service == null) return own(404, "unknown", `There is no service "${id}" here.`);
    if (!service.enabled) {
      return own(
        503,
        "paused",
        `${sharer} paused ${service.name}. It is back when ${sharer} turns it on again.`,
      );
    }
    return router(request);
  };
}

function own(status: number, marker: string, message: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(message)}</title><p>${escapeHtml(message)}</p>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", [SERVICE_MARKER]: marker },
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
