# The relay, as a container.
#
# BUILD CONTEXT IS THE UMBRELLA ROOT, NOT THIS DIRECTORY, and that is forced
# rather than chosen: `pnpm-lock.yaml` lives only at the umbrella root (this
# submodule tracks no lockfile of its own), so nothing here can be installed
# reproducibly from a context rooted at this app. Build it as:
#
#     docker build -f workspaces/statewalker-sandbox/apps/httpeers-relay/Dockerfile .
#
# from the umbrella root. `.dockerignore` there keeps the context to four files
# plus this app -- verified: a naive context would carry every other workspace.
#
# THE CONTEXT IS FOUR FILES PLUS THIS APP, and no other workspace's manifests.
# `pnpm install --frozen-lockfile --filter` tolerates a workspace whose other
# importers are absent from disk; measured, not assumed -- it resolves the 89
# packages this relay needs from the lockfile and installs nothing else.
#
# PID 1 IS `node`. Every stage below ends in a JSON-array `ENTRYPOINT`, so there
# is no shell between `docker stop` and the process: SIGTERM reaches the relay,
# `main.ts`'s handler runs, and `stop()` closes the HTTP surface and the
# WebSocket listener before the process exits. A shell or `pnpm` wrapper as PID
# 1 swallows the signal, the container is SIGKILLed after the grace period, and
# reservations are dropped rather than released. This branch already found that
# exact shape once in `apps/httpeers-stack/scripts/start.sh`.
#
# NO `node-datachannel`, AND THAT WAS CHECKED. It is what `@libp2p/webrtc`
# needs, and the hub needs that -- but the relay does not carry `@libp2p/webrtc`
# at all. Verified two ways from this app: `pnpm why node-datachannel` reports
# nothing, and `require.resolve("node-datachannel")` fails. So there is no
# native addon in this image and no prebuild step to get wrong.

# ---------------------------------------------------------------------------
# Stage 1: the production dependency tree, lockfile-pinned.
# ---------------------------------------------------------------------------
FROM node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS deps
WORKDIR /app

# Manifests only, so this layer is reused whenever nothing but source changed.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY workspaces/statewalker-sandbox/apps/httpeers-relay/package.json \
     workspaces/statewalker-sandbox/apps/httpeers-relay/

# `--frozen-lockfile` is the point: a build that quietly re-resolved would make
# "rollback is re-pinning a tag" untrue.
RUN corepack enable && \
    pnpm install --frozen-lockfile --filter @statewalker/httpeers-relay --prod

# ---------------------------------------------------------------------------
# Stage 2: compile TypeScript to JavaScript.
# ---------------------------------------------------------------------------
# A SEPARATE INSTALL because this one needs devDependencies (`typescript`),
# which must not reach the runtime image. The alternative -- one install then
# `pnpm prune` -- leaves the pruned files in an earlier layer, and a layer is
# permanent.
FROM node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY workspaces/statewalker-sandbox/apps/httpeers-relay/package.json \
     workspaces/statewalker-sandbox/apps/httpeers-relay/
RUN corepack enable && \
    pnpm install --frozen-lockfile --filter @statewalker/httpeers-relay

COPY workspaces/statewalker-sandbox/apps/httpeers-relay/tsconfig.json \
     workspaces/statewalker-sandbox/apps/httpeers-relay/tsconfig.build.json \
     workspaces/statewalker-sandbox/apps/httpeers-relay/
COPY workspaces/statewalker-sandbox/apps/httpeers-relay/src \
     workspaces/statewalker-sandbox/apps/httpeers-relay/src
RUN pnpm --filter @statewalker/httpeers-relay run build

# ---------------------------------------------------------------------------
# Stage 3: what actually ships.
# ---------------------------------------------------------------------------
FROM node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

# NO TOOLCHAIN, NO SOURCE, NO PACKAGE MANAGER. `corepack` is never enabled
# here: nothing in this stage installs anything, and a runtime image that can
# reach a registry is a runtime image that can be changed after it was signed
# off.
WORKDIR /app

# pnpm's tree is symlinks into `/app/node_modules/.pnpm`, so BOTH directories
# have to travel -- copying only the app's `node_modules` yields dangling links
# that fail at the first import.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node \
     /app/workspaces/statewalker-sandbox/apps/httpeers-relay/node_modules \
     ./workspaces/statewalker-sandbox/apps/httpeers-relay/node_modules
COPY --from=deps --chown=node:node \
     /app/workspaces/statewalker-sandbox/apps/httpeers-relay/package.json \
     ./workspaces/statewalker-sandbox/apps/httpeers-relay/
COPY --from=build --chown=node:node \
     /app/workspaces/statewalker-sandbox/apps/httpeers-relay/dist \
     ./workspaces/statewalker-sandbox/apps/httpeers-relay/dist

WORKDIR /app/workspaces/statewalker-sandbox/apps/httpeers-relay

# NON-ROOT. `node` is the unprivileged user the base image already ships; the
# relay writes nothing and needs no capability beyond binding two high ports.
USER node

# Both ports, both from `./src/config.ts`'s defaults. Documentation rather than
# enforcement -- `EXPOSE` publishes nothing on its own -- but a reader of this
# file should not have to go and find out which ports matter.
EXPOSE 9090 9099

# CONFIGURATION IS ENVIRONMENT ONLY. Nothing is baked in, nothing is read from a
# file that ships in the image, and there is deliberately no `ENV RELAY_KEY`:
# a key in an `ENV` is a key in a layer, readable by anyone who pulls the image.
# See the README's table for every variable.

# `/health` on the second port, using node itself -- the image has no curl and
# adding one to run a health check would be adding a shell's worth of attack
# surface to answer a question node can answer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.RELAY_HTTP_PORT ?? 9099}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# JSON-ARRAY FORM, SO THERE IS NO SHELL AND `node` IS PID 1. See the header.
ENTRYPOINT ["node", "dist/main.js"]
