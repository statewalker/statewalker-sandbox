/**
 * `contacts.edit` — answers `contacts:edit:open`; contributes Edit (selection action) and the
 * Contacts menu group's "Edit contact". Save commits the draft as it stands when Save is processed.
 */
import {
  type ActionDesc,
  type Behavior,
  type BundleManifest,
  type Contributed,
  contribute,
  defineStream,
} from "../../kernel/index.js";
import { newNotifier } from "../../kit/notify.js";
import {
  type Contact,
  type ContactEditorState,
  type ContactsEditMsg,
  contactsCore,
  contactsEdit,
  directory,
  editorKind,
  selection,
  selectionActions,
} from "../contacts/api/index.js";
import { menu, type Panel, panels } from "../shell/api/index.js";

const view = defineStream<ContactEditorState>("contacts.edit:view");

interface Session {
  readonly id: string;
  draft: { name: string; email: string; phone: string };
  error?: string;
  saving: boolean;
}

export function contactsEditBundle(options: { notifyTimeoutMs?: number } = {}): BundleManifest {
  const behavior: Behavior<ContactsEditMsg> = (ctx) => {
    const notifier = newNotifier(ctx, options.notifyTimeoutMs);
    let contacts: readonly Contact[] = [];
    let selected: Contact | null = null;
    let session: Session | undefined;
    let panel: Contributed<Panel> | undefined;

    const editAction = (label: string): ActionDesc => ({
      id: "edit-contact",
      label,
      enabled: selected !== null,
      to: contactsEdit,
      msg: { type: "contacts:edit:open", id: selected?.id ?? "" },
    });
    const selItem = contribute(ctx, selectionActions, "contacts.edit:edit", {
      order: 0,
      action: editAction("Edit"),
    });
    const menuItem = contribute(ctx, menu, "contacts.edit:edit", {
      group: "contacts",
      groupLabel: "Contacts",
      order: 0,
      action: editAction("Edit contact"),
    });
    ctx.subscribe(directory, (d) => {
      contacts = d ?? [];
    });
    ctx.subscribe(selection, (s) => {
      selected = s ?? null;
      selItem.update({ order: 0, action: editAction("Edit") });
      menuItem.update({
        group: "contacts",
        groupLabel: "Contacts",
        order: 0,
        action: editAction("Edit contact"),
      });
    });

    const render = () => {
      if (!session) return;
      ctx.publish(view, {
        draft: { ...session.draft },
        error: session.error,
        save: {
          id: "save",
          label: session.saving ? "Saving…" : "Save",
          enabled: !session.saving,
          running: session.saving,
          to: contactsEdit,
          msg: { type: "save" },
        },
        cancel: {
          id: "cancel",
          label: "Cancel",
          enabled: true,
          to: contactsEdit,
          msg: { type: "cancel" },
        },
      });
    };
    const close = () => {
      session = undefined;
      panel?.withdraw();
      panel = undefined;
    };

    return (msg, env) => {
      if (notifier.handle(msg)) return;
      switch (msg.type) {
        case "contacts:edit:open": {
          const c = contacts.find((x) => x.id === msg.id);
          if (!c) return env.fail(new Error(`no contact "${msg.id}"`));
          session = {
            id: c.id,
            draft: { name: c.name, email: c.email, phone: c.phone },
            saving: false,
          };
          render();
          const value: Panel = {
            kind: editorKind.id,
            stream: view,
            inbox: contactsEdit,
            title: `Edit ${c.name}`,
            placement: "side",
            order: 20,
          };
          if (panel) panel.update(value);
          else panel = contribute(ctx, panels, "contacts:editor", value);
          return env.ok();
        }
        case "edit":
          if (!session) return;
          session.draft = { ...session.draft, [msg.field]: msg.value };
          return render();
        case "cancel":
          return close();
        case "save": {
          const s = session;
          if (!s || s.saving) return;
          const patch = { ...s.draft }; // the commit, captured now
          s.saving = true;
          render();
          ctx.pipe(
            ctx.ask(contactsCore, { type: "contacts:update", id: s.id, patch }),
            () => {
              if (session === s) close();
              notifier.notify("Saved", "success");
            },
            (e) => {
              const message = e instanceof Error ? e.message : String(e);
              notifier.notify(`Saving failed: ${message}`, "error");
              if (session !== s) return;
              s.saving = false;
              s.error = message;
              render();
            },
          );
          return;
        }
      }
    };
  };
  return { id: contactsEdit, behavior };
}
