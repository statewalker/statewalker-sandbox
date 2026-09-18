/** `contacts.core` — the service actor: owns the api and publishes `contacts:directory`. */
import type { Behavior, BundleManifest } from "../../kernel/index.js";
import {
  type Contact,
  type ContactApi,
  type ContactsCoreMsg,
  contactsCore,
  directory,
} from "../contacts/api/index.js";
import { memContactApi } from "./mem-contact-api.js";

export function contactsCoreBundle(options: { api?: ContactApi } = {}): BundleManifest {
  const behavior: Behavior<ContactsCoreMsg> = (ctx) => {
    const api = options.api ?? memContactApi();
    let contacts: readonly Contact[] = [];
    const set = (next: readonly Contact[]) => {
      contacts = next;
      ctx.publish(directory, contacts);
    };
    ctx.pipe(api.list(), set, (e) => ctx.log.error("loading contacts failed", e));
    return (msg, env) => {
      ctx.pipe(
        api.update(msg.id, msg.patch),
        (updated) => {
          set(contacts.map((c) => (c.id === updated.id ? updated : c)));
          env.ok(updated);
        },
        env.fail,
      );
    };
  };
  return { id: contactsCore, behavior };
}
