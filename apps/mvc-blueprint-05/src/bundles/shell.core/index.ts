/**
 * shell.core — the technology-neutral part of the shell: it owns the toasts.
 * Any bundle shows a toast by returning `dispatchFx(shellNotify(...))` from its update.
 */
import {
  type Activator,
  afterSub,
  defineMsg,
  disposers,
  getKey,
  getStore,
  hasKey,
  useFields,
} from "../../kernel/index.ts";
import {
  NOTIFICATION_TIMEOUT_KEY,
  type Notification,
  shellNotifications,
  shellNotify,
} from "../shell/api/index.ts";

interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: Notification["tone"];
}
interface ShellState {
  readonly toasts: readonly Toast[];
  readonly seq: number;
}
const dismiss = defineMsg<{ id: string }>("shell.core/dismiss");

const useAppFields = useFields({ store: getStore });

export const activate: Activator = async (context) => {
  const { store } = useAppFields(context);
  const timeoutMs = hasKey(context, NOTIFICATION_TIMEOUT_KEY)
    ? getKey<number>(context, NOTIFICATION_TIMEOUT_KEY)
    : 4000;

  const slice = store.addSlice<ShellState>({
    id: "shell.core",
    init: () => ({ toasts: [], seq: 0 }),
    update(state, msg) {
      if (shellNotify.match(msg)) {
        const id = `toast-${state.seq + 1}`;
        return {
          seq: state.seq + 1,
          toasts: [...state.toasts, { id, message: msg.message, tone: msg.tone }],
        };
      }
      if (dismiss.match(msg)) {
        return { ...state, toasts: state.toasts.filter((t) => t.id !== msg.id) };
      }
      return state;
    },
    subscriptions: (state) =>
      state.toasts.map((t) => afterSub(`toast:${t.id}`, timeoutMs, dismiss({ id: t.id }))),
  });
  return disposers(
    slice.contribute(shellNotifications, "shell.core", (state) =>
      state.toasts.map((t) => ({ ...t, dismiss: dismiss({ id: t.id }) })),
    ),
    slice.dispose,
  );
};
