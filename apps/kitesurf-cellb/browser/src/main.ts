// Drives Kitesurf (running on CellB in a Dedicated Worker) over CDP, inside this page.
const out = document.getElementById("log")!;
const log = (s: string) => {
  out.textContent += `${s}\n`;
  console.log(s);
};
const target = new URLSearchParams(location.search).get("url") ?? "https://example.com/";
const result: Record<string, unknown> = { target };
(window as any).__result = result;

const worker = new Worker(new URL("./host-worker.ts", import.meta.url), { type: "module" });
// Any failure ends the run (run.mjs waits for `done`), before `ready` as well as after.
const fail = (message: string) => {
  result.error ??= message;
  result.done = true;
  log(String(message));
};
worker.onerror = (e) => fail(`worker error: ${e.message}`);
window.addEventListener("error", (e) => fail(`page error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => fail(`page rejection: ${e.reason}`));
const ready = await new Promise<any>((r) =>
  worker.addEventListener("message", (e) => e.data.type === "ready" && r(e.data)),
);
log(`engine loaded in ${ready.ms} ms; unsupported: ${JSON.stringify(ready.unsupported)}`);
result.loadMs = ready.ms;

const health = await new Promise<any>((r) => {
  worker.addEventListener(
    "message",
    (e) => e.data.type === "response" && e.data.id === 1 && r(e.data),
  );
  worker.postMessage({ type: "fetch", id: 1, url: "http://kitesurf/json/version" });
});
log(`/json/version: ${health.status} ${health.text}`);

// A CDP connection over a MessagePort to the engine's /devtools/browser socket.
const channel = new MessageChannel();
worker.postMessage({ type: "ws", url: "http://kitesurf/devtools/browser", port: channel.port2 }, [
  channel.port2,
]);
const port = channel.port1;
let nextId = 0;
const waiting = new Map<number, (m: any) => void>();
const listeners: ((m: any) => void)[] = [];
await new Promise<void>((resolve, reject) => {
  port.onmessage = (e) => {
    if (e.data.error) return reject(new Error(e.data.error));
    if (e.data.open) return resolve();
    if (e.data.data === undefined) return;
    const m = JSON.parse(e.data.data);
    if (m.id !== undefined) waiting.get(m.id)?.(m);
    else for (const l of listeners) l(m);
  };
});
const send = (method: string, params: object = {}, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, (m) =>
      m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result),
    );
    port.postMessage(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const event = (method: string, sessionId: string, ms: number) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${method} in ${ms} ms`)), ms);
    listeners.push((m) => {
      if (m.method === method && m.sessionId === sessionId) {
        clearTimeout(timer);
        resolve(m.params);
      }
    });
  });

try {
  log(`Browser.getVersion: ${JSON.stringify(await send("Browser.getVersion"))}`);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  const t1 = performance.now();
  const loaded = event("Page.loadEventFired", sessionId, 180_000);
  await send("Page.navigate", { url: target }, sessionId);
  await loaded;
  result.navigateMs = Math.round(performance.now() - t1);
  const evaluate = async (expression: string) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  result.title = await evaluate("document.title");
  result.text = String(await evaluate("document.body.innerText"))
    .replace(/\s+/g, " ")
    .slice(0, 200);
  const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  result.screenshot = shot.data;
  log(`title: ${result.title} (navigate ${result.navigateMs} ms)`);
  // `?pdf=1`: also print the page to PDF (A4, backgrounds on).
  if (new URLSearchParams(location.search).get("pdf")) {
    const t2 = performance.now();
    const pdf = await send(
      "Page.printToPDF",
      {
        paperWidth: 8.27,
        paperHeight: 11.69,
        printBackground: true,
        marginTop: 0.4,
        marginBottom: 0.4,
        marginLeft: 0.4,
        marginRight: 0.4,
      },
      sessionId,
    );
    if (pdf.error) throw new Error(`Page.printToPDF: ${pdf.error}`);
    result.pdf = pdf.data;
    result.pdfMs = Math.round(performance.now() - t2);
    log(`PDF: ${Math.round((pdf.data.length * 3) / 4)} bytes in ${result.pdfMs} ms`);
  }
  const img = document.createElement("img");
  img.src = `data:image/png;base64,${shot.data}`;
  document.body.append(img);
} catch (e) {
  result.error = String((e as Error).stack ?? e);
  log(`failed: ${result.error}`);
}
result.done = true;
