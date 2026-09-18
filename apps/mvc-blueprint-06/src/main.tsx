/// <reference types="vite/client" />
import "./index.css";
import { contactsStandalone, todosStandalone, workbenchReact } from "./apps/react.js";
import { ActorSystem, application } from "./kernel/index.js";

const root = document.getElementById("root");
if (!root) throw new Error('index.html has no <div id="root">');
const which = new URLSearchParams(location.search).get("app");
const manifest =
  which === "todos"
    ? todosStandalone(root)
    : which === "contacts"
      ? contactsStandalone(root)
      : workbenchReact(root);
const system = new ActorSystem();
void application(manifest)(system);
Object.assign(globalThis, { system });
