/** Logic feature manifests (no UI technology). Configuration travels in the manifest, by value. */

import type { ContactApi } from "./bundles/contacts/api/index.js";
import { contactsCoreBundle } from "./bundles/contacts.core/index.js";
import { contactsEditBundle } from "./bundles/contacts.edit/index.js";
import { contactsListBundle } from "./bundles/contacts.list/index.js";
import { shellActor } from "./bundles/shell/actor/index.js";
import type { TodoApi } from "./bundles/todos/api/index.js";
import { todosClearCompletedBundle } from "./bundles/todos.clear-completed/index.js";
import { todosContactsLinkBundle } from "./bundles/todos.contacts-link/index.js";
import { todosCoreBundle } from "./bundles/todos.core/index.js";
import { todosEditBundle } from "./bundles/todos.edit/index.js";
import { todosListBundle } from "./bundles/todos.list/index.js";
import { todosRenameBundle } from "./bundles/todos.rename/index.js";
import { todosStatusBundle } from "./bundles/todos.status/index.js";
import type { FeatureManifest } from "./kernel/index.js";

export interface LogicOptions {
  readonly todoApi?: TodoApi;
  readonly contactApi?: ContactApi;
  readonly notifyTimeoutMs?: number;
}

export const shellFeature: FeatureManifest = { id: "shell", bundles: [shellActor] };

export const todosFeature = (o: LogicOptions = {}): FeatureManifest => ({
  id: "todos",
  requires: ["shell"],
  bundles: [
    todosCoreBundle({ api: o.todoApi }),
    todosListBundle,
    todosEditBundle({ notifyTimeoutMs: o.notifyTimeoutMs }),
    todosClearCompletedBundle({ notifyTimeoutMs: o.notifyTimeoutMs }),
    todosRenameBundle,
  ],
});

export const todosStatusFeature: FeatureManifest = {
  id: "todos.status",
  requires: ["todos"],
  bundles: [todosStatusBundle],
};

export const contactsFeature = (o: LogicOptions = {}): FeatureManifest => ({
  id: "contacts",
  requires: ["shell"],
  bundles: [
    contactsCoreBundle({ api: o.contactApi }),
    contactsListBundle,
    contactsEditBundle({ notifyTimeoutMs: o.notifyTimeoutMs }),
  ],
});

export const todosContactsFeature: FeatureManifest = {
  id: "todos-contacts",
  requires: ["todos", "contacts"],
  bundles: [todosContactsLinkBundle],
};

/** Every logic feature of the workbench. */
export const logicFeatures = (o: LogicOptions = {}): FeatureManifest[] => [
  shellFeature,
  todosFeature(o),
  todosStatusFeature,
  contactsFeature(o),
  todosContactsFeature,
];
