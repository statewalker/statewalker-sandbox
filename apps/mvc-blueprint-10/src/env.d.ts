/** P2: selects the `contacts.edit` edition at build/test time (Vite replaces it statically). */
interface ImportMetaEnv {
  readonly VITE_CONTACTS_EDIT?: "fsm" | "xstate";
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
