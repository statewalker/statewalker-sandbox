/**
 * The platform: every app of this package behind one fetch handler, with all their Durable
 * Object classes. Hosts without cross-script service bindings (celld, cellb) run it as one
 * script; the apps can also be deployed alone (src/entries/*.ts).
 */
import { BuildJob, handleBuilds } from "./bundler/job.js";
import { handleCdn, ModuleHost } from "./cdn/cdn.js";
import { handleRegistry, PackageRegistry } from "./core/registry.js";
import { CORS, text, withCors } from "./core/util.js";
import { handleProjects, Project } from "./projects/project.js";

export { BuildJob, ModuleHost, PackageRegistry, Project };

export interface PlatformEnv {
  REGISTRY: DurableObjectNamespace;
  CDN: DurableObjectNamespace;
  PROJECTS: DurableObjectNamespace;
  BUILDS: DurableObjectNamespace;
  NOTEBOOKS: DurableObjectNamespace;
  REGISTRY_URL?: string;
  PACKUMENT_TTL_S?: string;
  /** Build tier limits: a build of more input bytes than this waits for a Node runner. */
  IN_OBJECT_BUILD_MAX_BYTES?: string;
}

type Handler = (req: Request, env: PlatformEnv, ctx: ExecutionContext) => Promise<Response>;
const routes: [string, Handler][] = [
  ["/registry/", (r, e) => handleRegistry(r, e)],
  ["/npm/", (r, e) => handleCdn(r, e)],
  ["/p/", (r, e) => handleProjects(r, e)],
  ["/builds", (r, e) => handleBuilds(r, e)],
  ["/b/", (r, e) => handleBuilds(r, e)],
];

export function addRoute(prefix: string, handler: Handler) {
  routes.push([prefix, handler]);
}

export async function handlePlatform(
  request: Request,
  env: PlatformEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  for (const [prefix, handler] of routes) {
    if (url.pathname.startsWith(prefix) || `${url.pathname}/` === prefix) {
      try {
        return withCors(await handler(request, env, ctx));
      } catch (e) {
        return withCors(text(`${(e as Error).stack ?? e}\n`, 500));
      }
    }
  }
  if (url.pathname === "/") return text(INDEX);
  return text("not found\n", 404);
}

const INDEX = `webrun platform

  /registry/<name>                    npm registry, cached (package store)
  /npm/<browser|node>/<spec>          ESM CDN (webrun-modules)
  /p/<project>/…                      user code as ESM (webrun-modules)
  /builds, /b/<build>/…               bundler (webrun-bundler)
  /nb/<site>/…                        Observable notebooks compiled to pages
`;
