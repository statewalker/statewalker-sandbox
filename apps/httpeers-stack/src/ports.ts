/**
 * The ports this deployment's page origins bind, and nothing else.
 *
 * A FILE OF THREE NUMBERS, BECAUSE OF WHO NEEDS THEM. These constants used
 * to live in `./static-server/main.ts`, which is where they are USED -- and
 * that module imports `node:http`/`node:https`/`node:fs` and, at top level,
 * evaluates `process.argv` in its run-as-a-process guard. Importing it from
 * a browser page to read one number therefore does not merely bloat the
 * bundle: `process` is undefined in a tab, so the import throws before a
 * single line of page code runs. The hub page (`./pages/hub/main.ts`) needs
 * these, to compose the join links it hands out for the OTHER two origins.
 *
 * `./static-server/main.ts` re-exports all three, so every existing
 * importer is unaffected and there is still exactly one definition.
 *
 * WHY THEY ARE FIXED AND NOT ENV-CONFIGURABLE: see that module's own
 * "ONE PORT PER PAGE IS A CORRECTNESS REQUIREMENT" note. Each page needs
 * its own origin, and a link one page hands another has to name a port both
 * agree on without being told.
 */

/** The main app's port. Fixed by the brief -- not an env-configurable knob. */
export const APP_PORT = 5175;
/** The image peer's port. Fixed by the brief -- not an env-configurable knob. */
export const IMAGE_PEER_PORT = 5176;
/** The hub page's port (Task 24) -- the next one along from the image peer's, for the same reasons and with the same fixedness. */
export const HUB_PAGE_PORT = 5177;
/** The proxy page's dev port. See the note on `APP_PORT` for why these are fixed. */
export const PROXY_PAGE_PORT = 5178;
