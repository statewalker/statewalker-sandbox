// The page: starts the cells worker and exposes `window.capfs.api(path, body, { admin })`, the
// same HTTP API the Node runtimes serve (used by the demo UI and the Playwright tests).
import { connectRuntime } from "@statewalker/cellb";

declare global {
  interface Window {
    capfs: {
      ready: Promise<void>;
      api: (path: string, body?: unknown, opts?: { admin?: boolean }) => Promise<unknown>;
    };
  }
}

const data = new URL(location.href).searchParams.get("data") ?? "flue-capfs";
const worker = new Worker(`/cells-worker.js?data=${encodeURIComponent(data)}`, { type: "module" });
const loaded = new Promise<void>((ok, ko) => {
  worker.addEventListener("message", (e) => e.data?.type === "loaded" && ok());
  worker.addEventListener("error", (e) => ko(new Error(e.message)));
});

let remote: Awaited<ReturnType<typeof connectRuntime>>;
const ready = (async () => {
  await loaded;
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ type: "connect", port: port2 }, [port2]);
  remote = await connectRuntime(port1);
})();

async function api(path: string, body?: unknown, opts: { admin?: boolean } = {}) {
  await ready;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.admin) headers.authorization = "Bearer dev-admin-key";
  const res = await remote.fetch(
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, ...(await res.json()) };
}

window.capfs = { ready, api };

// ---- demo UI ----
const $ = (id: string) => document.getElementById(id) as HTMLElement;
ready.then(
  () => ($("status").textContent = "ready"),
  (e) => ($("status").textContent = `failed: ${e}`),
);
$("run")?.addEventListener("click", async () => {
  const out = $("out");
  out.textContent = "running…";
  const ws = "demo";
  await api(
    `/api/w/${ws}/seed`,
    { files: { "/proj/data.csv": "a,b\n1,2\n3,4\n", "/hr/salaries.csv": "secret" } },
    { admin: true },
  );
  const s = (await api(
    `/api/w/${ws}/sessions`,
    { user: "alice", rights: ["/proj"] },
    { admin: true },
  )) as {
    value: { token: string };
  };
  const r = await api(`/api/agents/demo/run`, {
    workspace: ws,
    token: s.value.token,
    transport: "stub",
    task: { kind: "python", code: ($("code") as HTMLTextAreaElement).value },
  });
  out.textContent = JSON.stringify(r, null, 2);
});
