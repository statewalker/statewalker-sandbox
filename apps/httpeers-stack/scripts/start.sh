#!/usr/bin/env bash
# Boots the full httpeers-stack -- relay, then hub, then static server, in
# that order -- and tears all three down together on Ctrl-C.
#
# UNLIKE webrun-wire's p2p-demo/scripts/start.sh, this script never scrapes
# a child's stdout for its multiaddr or peerId. That demo's identities are
# ephemeral (a fresh key every run), so parsing the relay's freshly printed
# multiaddr out of its log was the only way to hand it to the other
# processes. This stack's identities are NOT ephemeral: `pnpm setup`
# generates `.httpeers/{relay,hub}.key` once and reuses them thereafter, and
# writes everything a dialer needs -- relayAddrs, hubPeerId -- into
# `httpeers.json`, a durable file every process (and, over HTTP, every
# browser page) reads for itself. There is nothing left for this script to
# extract from a log line. Only the trap/cleanup shape below is borrowed
# from that script's pattern, which is sound; its stdout-parsing is not
# copied.
#
# Env knobs:
#   RELAY_PORT -- the relay's WS listen port (default 9090, matches
#                 relay/main.ts's own default -- used here only to know
#                 which local port to poll for "the relay is up").

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
RELAY_PORT="${RELAY_PORT:-9090}"

if [[ ! -f "$ROOT/httpeers.json" ]]; then
  echo "[httpeers-stack] httpeers.json not found -- run \"pnpm setup\" first." >&2
  exit 1
fi

pids=()
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "[httpeers-stack] shutting down..."
  for pid in "${pids[@]:-}"; do
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

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

echo "[httpeers-stack] starting hub..."
(cd "$ROOT" && exec pnpm run start:hub) &
hub_pid=$!
pids+=("$hub_pid")

# The hub reserves a slot through the relay rather than binding a fixed,
# externally-knowable port of its own -- httpeers.json's own shape
# (relayAddrs + hubPeerId, no hub port) reflects that there is nothing to
# TCP-poll it on. A short fixed pause is enough to catch an immediate
# failure (a missing/corrupt key, a crash on startup) before moving on.
sleep 1
if ! kill -0 "$hub_pid" 2>/dev/null; then
  echo "[httpeers-stack] hub exited immediately after starting" >&2
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
