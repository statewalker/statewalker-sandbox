# 18 — Can a repository export the pack git expects, streaming, with backpressure and cancel?

Plan id **X6** (pack ingest/export), slice **X6c: pack export**. Status: **open**.

## Question

Push and serve (and P2P sync over httpeers) need the other half of X6: given what the other side
wants and what it has, produce the objects it lacks as a pack git accepts. Over X16a's
`Repository` (git files or SQL), can we

- walk the objects as `git rev-list --objects <wants> --not <haves>` does,
- write them as a pack — streaming (memory bounded by an object, not the pack), pulled by the
  consumer (backpressure), cancellable with an `AbortSignal` within one object —
- that `git index-pack` and X6b accept, in Node and in a Durable Object,

and how large is a pack of whole objects next to git's (which reuses and computes deltas)?

## Reject condition

Rejected if git refuses the pack or the object set differs from git's, if memory grows with the
pack, if the producer runs ahead of the consumer, or if a cancel does not stop it.

## Acceptance criteria (fixed before code)

| # | Requirement |
|---|---|
| R1 | For a native-git repository (files backend), the export for `wants = [HEAD]` (no haves) has exactly the objects of `git rev-list --objects HEAD`; `git index-pack` accepts it, and a repository built from it passes `git fsck --full` with the same `git log`. |
| R2 | Incremental: `wants = [HEAD]`, `haves = [HEAD~5]` gives exactly `git rev-list --objects HEAD ^HEAD~5`; a receiver holding `HEAD~5` installs it (native git and X6b) and passes `git fsck`. Annotated tags among the wants are sent with what they point at. |
| R3 | SQL backend: a repository received into `sqlRepository` exports a pack another `sqlRepository` receives; the logs are equal. |
| R4 | A 64 MiB incompressible blob is exported with < 16 MiB extra live memory. |
| R5 | Backpressure: while the consumer holds back, the producer reads at most one object ahead; an `AbortSignal` aborted mid-pack stops the export with an `AbortError` within one object, and every object stream it opened is released. |
| R6 | The pack size, next to `git pack-objects` for the same objects, is measured and recorded (whole objects, no deltas: the price of not reusing deltas yet). |
| R7 | In a Durable Object (SQL backend) the export of X6a's fixture history is accepted by native git (`index-pack`, `fsck`). |

## Scope — what this slice does NOT do

- Delta reuse or delta search (needs raw pack-entry access in X6r — X16a's open thread); thin packs
  (REF_DELTA against haves); the smart-HTTP / httpeers protocol framing (negotiation, sideband).
