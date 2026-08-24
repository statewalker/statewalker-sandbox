#!/usr/bin/env bash
# Boots the full httpeers-stack -- relay, then hub, then static server, in
# that order -- and tears all three down together on Ctrl-C.
#
# UNLIKE webrun-wire's p2p-demo/scripts/start.sh, this script never scrapes
# a child's stdout for its multiaddr or peerId. That demo's identities are
# ephemeral (a fresh key every run), so parsing the relay's freshly printed
# multiaddr out of its log was the only way to hand it to the other
# processes. This stack's identities are NOT ephemeral: `pnpm bootstrap`
# generates `.httpeers/{relay,hub}.key` once and reuses them thereafter, and
# writes everything a dialer needs -- relayAddrs, hubPeerId -- into
# `httpeers.json`, a durable file every process (and, over HTTP, every
# browser page) reads for itself. There is nothing left for this script to
# extract from a log line. Only the trap/cleanup shape below is borrowed
# from that script's pattern, which is sound; its stdout-parsing is not
# copied.
#
# The setup script is named `bootstrap`, not `setup`: `pnpm setup` is a
# pnpm built-in (it configures the user's shell environment) and wins over
# a same-named package script, silently doing nothing instead of running
# it. `pnpm bootstrap` is not a pnpm command, so it reaches the script.
#
# Env knobs:
#   RELAY_PORT -- the relay's WS listen port (default 9090, matches
#                 @statewalker/httpeers-relay's own default -- used here only to know
#                 which local port to poll for "the relay is up").
#   HUB_READY_FILE -- where the hub records that it has finished
#                 bootstrapping (default .httpeers/hub-ready, matches
#                 hub/main.ts's DEFAULT_HUB_READY_PATH). This script waits
#                 for it; see the hub section below.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
RELAY_PORT="${RELAY_PORT:-9090}"
HUB_READY_FILE="${HUB_READY_FILE:-$ROOT/.httpeers/hub-ready}"

if [[ ! -f "$ROOT/httpeers.json" ]]; then
  echo "[httpeers-stack] httpeers.json not found -- run \"pnpm bootstrap\" first." >&2
  exit 1
fi

pids=()
# Signal a process and everything under it, DEEPEST FIRST.
#
# WHY NOT `kill -- "-$pid"`. That was the previous implementation and it could
# never have worked: each child is spawned as `( ... ) & ` and the recorded pid
# is the `pnpm run start:*` wrapper, which is NOT a process-group leader -- this
# script's own group is. So the negative-pid group kill always failed, the
# fallback reached only the wrapper, and the real `sh -c` -> `tsx` -> `node`
# chain underneath was orphaned still holding every port. That is how a stack
# left running on 23 August came to outlive its supervisor by a day.
#
# Children before parents, so `node` receives the signal while its parent still
# exists to be waited on -- killing the wrapper first would reparent the node
# process and leave it running. Each relay/hub/static-server has its own SIGTERM
# handler; they were never broken, they simply never received one.
kill_tree() {
  local pid="$1" child
  for child in $(ps -o pid= --ppid "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "[httpeers-stack] shutting down..."
  for pid in "${pids[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
    fi
  done
  wait 2>/dev/null || true

  # The README promises no manual cleanup is ever necessary. Check it rather
  # than assert it: a survivor here is a bug worth seeing, not something to
  # discover later as a port that will not bind.
  local stragglers
  stragglers="$(pgrep -f 'src/(main|hub|static-server)/main\.ts|httpeers-relay/src/main\.ts' 2>/dev/null || true)"
  if [[ -n "$stragglers" ]]; then
    echo "[httpeers-stack] WARNING: these processes outlived shutdown: $stragglers" >&2
    echo "[httpeers-stack] that is a bug in this script, not routine -- please report it." >&2
  fi
  # The hub removes this itself on a clean SIGTERM; removing it here too
  # covers the hub dying without getting the chance, so the next run never
  # reads a ready marker left by a hub that is gone.
  rm -f "$HUB_READY_FILE"
}
trap cleanup EXIT INT TERM

# BUILD THE PAGES FIRST. The static server serves `dist/{app,image-peer,hub}`
# and does not build them, so without this the script happily starts and then
# serves whatever those directories last happened to contain -- a stale bundle,
# a partial one, or nothing at all on a fresh clone (three 404s).
#
# This is not hypothetical. A `dist/hub` was found missing only its `sw.js`:
# the page loaded, its ServiceWorker registration failed, `mountEdge` never
# resolved, the page never reached "ready", and every mint button stayed
# disabled -- which reads as "the hub has no way to generate invitations"
# rather than as a build problem. Building here makes that state unreachable.
#
# The e2e suite builds its own pages (`buildPages()`); this is for the
# operator's path, which nothing else covered.
echo "[httpeers-stack] building the three pages..."
for target in build:app build:image-peer build:hub-page; do
  if ! (cd "$ROOT" && pnpm run --silent "$target" >/dev/null); then
    echo "[httpeers-stack] \"pnpm run $target\" failed -- refusing to serve a stale build." >&2
    exit 1
  fi
done

echo "[httpeers-stack] starting relay on port $RELAY_PORT..."
(cd "$ROOT" && exec pnpm run start:relay) &
relay_pid=$!
pids+=("$relay_pid")

echo "[httpeers-stack] waiting for the relay to accept connections..."
relay_up=false
for _ in $(seq 1 60); do
  if ! kill -0 "$relay_pid" 2>/dev/null; then
    echo "[httpeers-stack] relay exited before it started listening" >&2
    exit 1
  fi
  # A plain TCP reachability probe -- not a read of anything the relay
  # sends, just "is something accepting connections on this port yet".
  if (exec 3<>"/dev/tcp/127.0.0.1/$RELAY_PORT") 2>/dev/null; then
    relay_up=true
    break
  fi
  sleep 0.5
done
if [[ "$relay_up" != true ]]; then
  echo "[httpeers-stack] timed out waiting for the relay to start listening" >&2
  exit 1
fi

# Any file left by a previous run is stale by definition -- the wait below
# would otherwise pass instantly on a hub that has not started yet.
rm -f "$HUB_READY_FILE"

echo "[httpeers-stack] starting hub..."
(cd "$ROOT" && HUB_READY_FILE="$HUB_READY_FILE" exec pnpm run start:hub) &
hub_pid=$!
pids+=("$hub_pid")

# THE HUB RESERVES A SLOT THROUGH THE RELAY, and this script waits until it
# actually has one. httpeers.json's own shape (relayAddrs + hubPeerId, no hub
# port) says a page reaches the hub through the relay and not at an address
# of its own -- which is true, and as of Task 20 it is also true of the
# running process: hub/main.ts dials the relay and holds a `/p2p-circuit`
# reservation before it reports ready. (Before Task 20 this comment claimed
# that reservation as fact while the hub was TCP-only and no page could reach
# it at all.)
#
# The wait is on the hub's ready FILE, not on a port and not on a log line.
# A TCP probe would not do: libp2p opens its listeners during node startup,
# BEFORE the relay grants anything, so an open hub port proves the process is
# alive and says nothing about reachability. And this script does not parse
# child stdout, for the reasons in its own header. hub/main.ts writes that
# file after the reservation and only after it.
echo "[httpeers-stack] waiting for the hub to reserve a slot on the relay..."
hub_up=false
for _ in $(seq 1 60); do
  if ! kill -0 "$hub_pid" 2>/dev/null; then
    echo "[httpeers-stack] hub exited before it finished starting" >&2
    exit 1
  fi
  if [[ -f "$HUB_READY_FILE" ]]; then
    hub_up=true
    break
  fi
  sleep 0.5
done
if [[ "$hub_up" != true ]]; then
  echo "[httpeers-stack] timed out waiting for the hub to reserve a slot on the relay" >&2
  exit 1
fi

echo "[httpeers-stack] starting static server..."
(cd "$ROOT" && exec pnpm run start:static) &
pids+=("$!")

echo "[httpeers-stack] ==================================================="
echo "[httpeers-stack] relay, hub, and static server are all running."
echo "[httpeers-stack] Ctrl-C to stop all three."
echo "[httpeers-stack] ==================================================="

# Block until any child exits, then cleanup kicks in via trap.
wait -n 2>/dev/null || wait
