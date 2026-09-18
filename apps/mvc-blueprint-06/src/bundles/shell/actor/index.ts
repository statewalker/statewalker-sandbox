/** The `shell` actor: owner of the generic UI extension points. It holds and publishes; it renders nothing. */
import { type BundleManifest, ownPoints } from "../../../kernel/index.js";
import { SHELL, shellPoints } from "../api/index.js";

export const shellActor: BundleManifest = {
  id: SHELL,
  behavior: (ctx) => {
    const points = ownPoints(ctx, shellPoints);
    return (msg, env) => {
      if (!points.handle(msg, env)) ctx.log.warn("the shell ignores a message", msg);
    };
  },
};
