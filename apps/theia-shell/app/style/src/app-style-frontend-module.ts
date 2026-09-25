// lib/app.css is Tailwind's output (see package.json "build"); Theia's bundler picks it up here.
import "./app.css";
import { ContainerModule } from "@theia/core/shared/inversify";

export default new ContainerModule(() => {});
