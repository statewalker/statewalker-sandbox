import { suggestKey, validateKey } from "./mount-keys";
import type { MountType } from "./mount-types";

/** What the mount form holds. */
export interface MountFormValues {
  name: string;
  /** The mount path as typed; used only once `keyEdited`. */
  key: string;
  /** Until the user edits the mount path, it follows the name. */
  keyEdited: boolean;
  fields: Record<string, string>;
}

export interface MountFormErrors {
  name?: string;
  key?: string;
  fields: Record<string, string>;
}

const URL_PATTERN = /^https?:\/\/[^/]/i;

/**
 * Checks the mount form: the name, the mount path (derived from the name until
 * edited; unique among `taken`), and the type's fields. When `editing`, an
 * empty secret keeps the stored value.
 */
export function validateMountForm(
  type: MountType,
  values: MountFormValues,
  options: { taken: readonly string[]; editing: boolean },
): { errors: MountFormErrors; valid: boolean; key: string } {
  const errors: MountFormErrors = { fields: {} };
  const name = values.name.trim();
  if (!name) errors.name = "A name is required.";
  const key = values.keyEdited ? values.key.trim() : suggestKey(name, options.taken);
  const keyError = validateKey(key, options.taken);
  if (keyError) errors.key = keyError;
  for (const field of type.fields) {
    const value = (values.fields[field.name] ?? "").trim();
    if (field.kind === "secret") {
      if (field.required && !value && !options.editing)
        errors.fields[field.name] = `${field.label} is required.`;
    } else if (field.required && !value) {
      errors.fields[field.name] = `${field.label} is required.`;
    } else if (field.kind === "url" && value && !URL_PATTERN.test(value)) {
      errors.fields[field.name] = "Enter an http:// or https:// URL.";
    }
  }
  const valid = !errors.name && !errors.key && Object.keys(errors.fields).length === 0;
  return { errors, valid, key };
}
