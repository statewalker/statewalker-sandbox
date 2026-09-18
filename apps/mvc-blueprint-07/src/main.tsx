/// <reference types="vite/client" />
import "./index.css";
import {
  contactsStandalone,
  todosStandalone,
  workbenchDebug,
  workbenchReact,
} from "./apps/manifests.js";
import { startApp } from "./apps/start.js";

const root = document.getElementById("root");
if (!root) throw new Error('index.html has no <div id="root">');
const which = new URLSearchParams(location.search).get("app");
const manifest =
  which === "todos"
    ? todosStandalone
    : which === "contacts"
      ? contactsStandalone
      : which === "debug"
        ? workbenchDebug
        : workbenchReact;
void startApp(manifest, root);
