#!/usr/bin/env bash
# Prints the operator's walkthrough: how to test this stack, how to launch it,
# and how to drive it in a browser once it is up.
#
# WHY THE SCRIPT IS NAMED `howto` AND NOT `help`. `pnpm help` is a pnpm
# BUILT-IN (it prints pnpm's own CLI usage) and a built-in always wins over a
# package script of the same name: a `"help"` entry here would be unreachable,
# `pnpm help` would print "Usage: pnpm [command] [flags]", and this file would
# never run. That is the same trap documented in the README for `pnpm setup`,
# which is why bootstrapping is `pnpm bootstrap`.
#
# `howto` is not a pnpm command, so pnpm falls through to the script and the
# bare `pnpm howto` works. (`pnpm run howto` works too, as for any script.)
#
# The content here duplicates nothing: it is the OPERATOR path, condensed.
# README.md remains the reference -- this is what someone needs in the terminal
# at the moment they are about to run something, not the reasoning behind it.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

# Colour only when stdout is a terminal and NO_COLOR is unset, so piping this
# into a file or a pager yields clean text rather than escape codes.
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; CYAN=$'\033[36m'; YEL=$'\033[33m'; R=$'\033[0m'
else
  B=''; DIM=''; CYAN=''; YEL=''; R=''
fi

h()   { printf '\n%s%s%s\n' "$B" "$1" "$R"; }
cmd() { printf '  %s%s%s\n' "$CYAN" "$1" "$R"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$R"; }
warn() { printf '  %s%s%s\n' "$YEL" "$1" "$R"; }

printf '%shttpeers-stack%s -- relay + hub + two browser peers, on one machine.\n' "$B" "$R"
note "$ROOT"

h '1. Run the tests'
cmd 'pnpm test'
note 'Typecheck + the full vitest suite, including the node and browser (Playwright)'
note 'e2e legs. Nothing needs to be running first -- the suites boot their own'
note 'relays and hubs on real ports. Takes about a minute.'

h '2. Launch the stack'
cmd 'pnpm start'
note 'Builds the three page bundles, then starts relay (9090, health on 9099),'
note 'hub (9091), and the static server -- waiting for each to be genuinely ready'
note 'before starting the next. Ctrl-C tears all three down together.'
echo
note 'On a fresh checkout, or if httpeers.json is missing, first:'
cmd 'pnpm bootstrap'
warn 'Do not run bootstrap casually on a working deployment. It is idempotent and'
warn 'keeps existing keys -- but the hub peerId IS the mesh identity, and losing'
warn '.httpeers/hub.key invalidates every token ever issued.'

h '3. Drive it in a browser'
note 'Open the HUB PAGE first. It is the only working entry point:'
cmd 'http://127.0.0.1:5177/'
warn 'The Node hub has no operator-reachable way to mint an invitation --'
warn 'InvitationStore.create is called only by tests, and GET /admin/invitations'
warn 'returns no invitation data despite its name. The hub page is a second hub'
warn 'implementation running in a tab, and it does mint on demand.'
echo
note '  a. Mint an invitation for the APP page. Copy its join link.'
note '  b. Open it -> http://127.0.0.1:5175/?join=<blob>  The app page joins.'
note '  c. Mint a SECOND invitation, for the image peer. Invitations are'
note '     single-use; a reused one fails with `already-redeemed`.'
note '  d. Open it -> http://127.0.0.1:5176/  The image peer joins.'
note '  e. Images now render on the app page. Those bytes are streaming from the'
note '     other tab over WebRTC, through the relay, into an <img>.'

h '4. What to look at while it is up'
note '- Member list: *Saved* is membership (survives reload); *Active* is presence'
note '  (heartbeat TTL). Two different things, deliberately shown apart.'
note '- Revoke a member, then watch the app page fail on its next call. The'
note '  policy-version bump is the evidence that tokens were revoked, not just'
note '  membership dropped.'
note '- Reload the app page: it resumes from its IndexedDB key rather than'
note '  needing a fresh invitation.'
echo
warn 'The hub page founds its OWN mesh (identity in that origin IndexedDB),'
warn 'separate from the Node hub .httpeers/hub.key. Its reset control does not'
warn 'rotate a credential -- it founds a different mesh, invalidating every token'
warn 'and every link already handed out.'

h '5. Stopping'
note 'Ctrl-C. start.sh traps it, kills every child deepest-first, and removes the'
note 'hub ready-marker. No manual cleanup should ever be necessary -- a surviving'
note 'process is a bug, not routine.'

h 'More'
note "README.md                    -- this app, in full"
note "../httpeers-relay/README.md  -- the relay's own configuration"
note "pnpm run                     -- every script in this package"
echo
