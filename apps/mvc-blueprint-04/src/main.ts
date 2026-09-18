/// <reference types="vite/client" />
import "./index.css";
import { shellRoot } from "@b/shell/api";
import { type ApplicationManifest, application, type Context } from "@kernel";

const apps: Record<string, () => Promise<ApplicationManifest>> = {
  "workbench.react": () => import("./apps/workbench.react.js").then((m) => m.workbenchReact),
  "workbench.dom": () => import("./apps/workbench.dom.js").then((m) => m.workbenchDom),
  "todos.standalone": () => import("./apps/todos.standalone.js").then((m) => m.todosStandalone),
  "contacts.standalone": () =>
    import("./apps/contacts.standalone.js").then((m) => m.contactsStandalone),
};

const root = document.getElementById("root");
if (!root) throw new Error('index.html has no <div id="root">');
const name = new URLSearchParams(location.search).get("app") ?? "workbench.react";
const load = apps[name];
if (!load) throw new Error(`unknown app "${name}"; one of ${Object.keys(apps).join(", ")}`);

const context: Context = {};
shellRoot.set(context, root);
const nav = document.createElement("p");
nav.className = "px-4 py-1 text-xs text-slate-500";
nav.innerHTML = Object.keys(apps)
  .map((a) => (a === name ? `<b>${a}</b>` : `<a href="?app=${a}">${a}</a>`))
  .join(" · ");
root.before(nav);
void load().then((manifest) => application(manifest)(context));
