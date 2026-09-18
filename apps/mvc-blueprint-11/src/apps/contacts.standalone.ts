import type { ApplicationManifest } from "@kernel";
import { contactsDom, shellTestFeature } from "../features/dom.js";
import { contacts } from "../features/logic.js";

/** Contacts alone, in the trivial test shell. No Todos code is loaded. */
export const contactsStandalone: ApplicationManifest = {
  id: "contacts.standalone",
  features: [shellTestFeature, contacts, contactsDom],
};
