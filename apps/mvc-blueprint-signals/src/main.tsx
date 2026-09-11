/// <reference types="vite/client" />
import "./index.css";
import { startApp } from "./app.js";

/**
 * The page's entry. Everything that knows the layers is in `app.ts` — the
 * composition root, which the B6 suite boots directly.
 */
const root = document.getElementById("root");
if (!root) throw new Error('index.html has no <div id="root">');
startApp(root);
