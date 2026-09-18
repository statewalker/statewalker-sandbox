import "./index.css";
import { applications } from "./apps/index.ts";
import { ROOT_KEY } from "./bundles/shell.react/index.tsx";
import { application } from "./kernel/index.ts";

const root = document.getElementById("root");
if (!root) throw new Error('index.html has no <div id="root">');
const id = new URLSearchParams(location.search).get("app") ?? "workbench.react";
const manifest = applications[id];
if (!manifest) throw new Error(`unknown app ${id}; one of ${Object.keys(applications).join(", ")}`);
await application(manifest)({ [ROOT_KEY]: root });
