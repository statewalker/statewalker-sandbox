/// <reference types="vite/client" />
import "./index.css";
import { startApp } from "./app.js";

const root = document.getElementById("root");
if (!root) throw new Error('index.html has no <div id="root">');
startApp(root);
