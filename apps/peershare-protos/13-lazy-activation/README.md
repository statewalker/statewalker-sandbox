# 13 — Can SandClaw list PeerShare without importing it?

`pnpm test 13-lazy-activation`

**Answer: yes.** `lazyFeature(PEERSHARE_MANIFEST, () => import(…))` puts the manifest's
menu items and command stubs into the suite at once. The first call of any PeerShare
command imports the Feature, swaps the stubs for its real contributions, and re-dispatches
that call. shell-protos rung 05 proved the same for the shell; this proves it for a Feature
with commands that return values.

## Measured, 2026-10-30

- The menu renders from the manifest, and PeerShare's code has not been evaluated (a module
  that marks its own evaluation is the evidence).
- The first `peershare:add-service` imports it **once** and is answered by the real Feature.
  The next call does not import again.
- **The manifest cannot drift:** after activation, the real menu items and handled commands
  are exactly the manifest's. A command added to the Feature but not to the manifest fails
  this test.

## Not answered here

Deriving the manifest from source without running it (shell-protos rung 04 does it with
static analysis). Here it is written by hand, and the drift test keeps it honest.
