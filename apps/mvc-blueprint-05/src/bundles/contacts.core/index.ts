/** contacts.core — owns the contacts slice and performs `contacts/update`. */
import {
  type Activator,
  defineMsg,
  disposers,
  getKey,
  getStore,
  hasKey,
  next,
  setKey,
  useFields,
} from "../../kernel/index.ts";
import {
  CONTACT_API_KEY,
  type Contact,
  type ContactApi,
  type ContactReply,
  type ContactUpdateEffect,
  contactsCollection,
} from "../contacts/api/index.ts";
import { createMemContactApi } from "./mem-api.ts";

interface CoreState {
  readonly contacts: readonly Contact[];
  readonly loaded: boolean;
}
const loaded = defineMsg<{ contacts: readonly Contact[] }>("contacts.core/loaded");
const LOAD = { type: "contacts.core/load" } as const;

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  if (!hasKey(context, CONTACT_API_KEY)) setKey(context, CONTACT_API_KEY, createMemContactApi());
  const { store } = useAppFields(context);
  const api = getKey<ContactApi>(context, CONTACT_API_KEY);

  const offLoad = store.addEffectHandler<typeof LOAD>(LOAD.type, async (_fx, io) => {
    io.dispatch(loaded({ contacts: await api.list() }));
  });
  const offUpdate = store.addEffectHandler<ContactUpdateEffect>(
    "contacts/update",
    async (fx, io) => {
      let error: string | undefined;
      try {
        await api.update(fx.id, fx.patch);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (!error) io.dispatch(loaded({ contacts: await api.list() }));
      const reply: ContactReply = {
        type: fx.reply,
        ref: fx.ref,
        ok: !error,
        error,
        id: fx.id,
        patch: fx.patch,
      };
      io.dispatch(reply);
    },
  );

  const slice = store.addSlice<CoreState>({
    id: "contacts.core",
    init: () => next({ contacts: [], loaded: false }, LOAD),
    update: (state, msg) => (loaded.match(msg) ? { contacts: msg.contacts, loaded: true } : state),
  });
  return disposers(
    offLoad,
    offUpdate,
    slice.contribute(contactsCollection, "contacts.core", (state) =>
      state.loaded ? [{ contacts: state.contacts }] : [],
    ),
    slice.dispose,
  );
};
