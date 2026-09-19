/// <reference types="vite/client" />
import "./index.css";
import { shellRoot } from "@b/shell/api";
import { type ApplicationManifest, application, type Context } from "@kernel";
import {
  contactsStandalone,
  type Technology,
  technologies,
  todosStandalone,
  workbench,
} from "./apps/workbenches.js";

const apps: Record<string, () => ApplicationManifest> = {};
for (const tech of Object.keys(technologies) as Technology[]) {
  apps[`workbench.${tech}`] = () => workbench(tech);
  apps[`todos.standalone.${tech}`] = () => todosStandalone(tech);
  apps[`contacts.standalone.${tech}`] = () => contactsStandalone(tech);
}

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
void application(load())(context);
