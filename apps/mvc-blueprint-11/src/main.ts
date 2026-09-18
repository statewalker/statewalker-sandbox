/// <reference types="vite/client" />
import "./index.css";
import { shellRoot } from "@b/shell/api";
import { type ApplicationManifest, application, type Context, configAdapter } from "@kernel";
import { MECHANISM_KEY } from "@kit/mechanism";

const apps: Record<string, () => Promise<ApplicationManifest>> = {
  "workbench.react": () => import("./apps/workbench.react.js").then((m) => m.workbenchReact),
  "workbench.dom": () => import("./apps/workbench.dom.js").then((m) => m.workbenchDom),
  "todos.standalone": () => import("./apps/todos.standalone.js").then((m) => m.todosStandalone),
  "contacts.standalone": () =>
    import("./apps/contacts.standalone.js").then((m) => m.contactsStandalone),
};

const root = document.getElementById("root");
if (!root) throw new Error('index.html has no <div id="root">');
const params = new URLSearchParams(location.search);
const name = params.get("app") ?? "workbench.react";
const commit = params.get("commit") ?? "C"; // P3: ?commit=A|B|C
const load = apps[name];
if (!load) throw new Error(`unknown app "${name}"; one of ${Object.keys(apps).join(", ")}`);

const context: Context = {};
shellRoot.set(context, root);
configAdapter.set(context, Object.freeze({ [MECHANISM_KEY]: commit }));
const nav = document.createElement("p");
nav.className = "px-4 py-1 text-xs text-slate-500";
nav.innerHTML = Object.keys(apps)
  .map((a) => (a === name ? `<b>${a}</b>` : `<a href="?app=${a}&commit=${commit}">${a}</a>`))
  .concat(
    ["A", "B", "C"].map((m) =>
      m === commit ? `<b>commit ${m}</b>` : `<a href="?app=${name}&commit=${m}">commit ${m}</a>`,
    ),
  )
  .join(" · ");
root.before(nav);
void load().then((manifest) => application(manifest)(context));
