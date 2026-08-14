import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./index.css";

const container = document.getElementById("app");
if (!container) throw new Error("#app is missing from index.html");
createRoot(container).render(<App />);
