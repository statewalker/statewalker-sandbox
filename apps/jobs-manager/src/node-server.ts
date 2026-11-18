import { serve as serveNode } from "@hono/node-server";

export type Server = { port: number; close: () => Promise<void> };

/** Serves a fetch handler (e.g. `createJobsApp(...).fetch`) over Node's http module. */
export function serve(
  handler: (request: Request) => Response | Promise<Response>,
  options: { port?: number; host?: string } = {},
): Promise<Server> {
  return new Promise((resolve) => {
    const server = serveNode(
      { fetch: handler, port: options.port ?? 8080, hostname: options.host },
      (info) =>
        resolve({
          port: info.port,
          close: () =>
            new Promise<void>((done, fail) => {
              if ("closeAllConnections" in server) server.closeAllConnections();
              server.close((e) => (e ? fail(e) : done()));
            }),
        }),
    );
  });
}
