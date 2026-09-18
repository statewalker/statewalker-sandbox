import { activate as contactsUiDom } from "@b/contacts.ui.dom";
import { activate as helloUiDom } from "@b/hello.ui.dom";
import { activate as shellDom } from "@b/shell.dom";
import { activate as shellTestDom } from "@b/shell.test/dom";
import { activate as todosUiDom } from "@b/todos.ui.dom";
import type { FeatureManifest } from "@kernel";

export const shellDomFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.dom",
      activator: shellDom,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

/** The trivial test shell (DOM variant), for the standalone runs. */
export const shellTestFeature: FeatureManifest = {
  id: "shell",
  bundles: [
    {
      id: "shell.test",
      activator: shellTestDom,
      requires: ["shell:root"],
      provides: ["shell:coverage"],
    },
  ],
};

export const todosDom: FeatureManifest = {
  id: "todos.dom",
  requires: ["todos"],
  bundles: [{ id: "todos.ui.dom", activator: todosUiDom }],
};

export const contactsDom: FeatureManifest = {
  id: "contacts.dom",
  requires: ["contacts"],
  bundles: [{ id: "contacts.ui.dom", activator: contactsUiDom }],
};

export const helloDom: FeatureManifest = {
  id: "hello.dom",
  requires: ["hello"],
  bundles: [{ id: "hello.ui.dom", activator: helloUiDom }],
};
