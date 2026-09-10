/**
 * An error or label is a KEY, never prose.
 *
 * Controllers stay language-free, tests assert on stable keys, translators work
 * from one catalogue, and the view layer resolves. This is the convention
 * `shared-commands` already established for `.label` / `.description`, reused
 * for dialog labels, notifications and job status lines — so the app carries one
 * i18n idiom and the view layer has exactly one resolver.
 */
export interface I18nRef {
  key: string;
  params?: Record<string, unknown>;
}
