import { validateKey } from "./mount-keys";
import type { MountConfig, MountType } from "./mount-types";

/**
 * Checks a `files.mounts` value as a user may have typed it. Every bad entry
 * is skipped with one error; the valid ones are returned in order.
 */
export function validateMountConfigs(
  raw: unknown,
  types: ReadonlyMap<string, MountType>,
  reserved: readonly string[],
): { valid: MountConfig[]; errors: string[] } {
  if (!Array.isArray(raw))
    return { valid: [], errors: ["files.mounts must be an array of mounts."] };
  const valid: MountConfig[] = [];
  const errors: string[] = [];
  const taken = [...reserved];
  raw.forEach((entry, index) => {
    const error = checkEntry(entry, types, taken);
    if (error) {
      errors.push(`files.mounts[${index}]: ${error}`);
      return;
    }
    const mount = entry as MountConfig;
    taken.push(mount.key);
    valid.push(mount);
  });
  return { valid, errors };
}

function checkEntry(
  entry: unknown,
  types: ReadonlyMap<string, MountType>,
  taken: string[],
): string | undefined {
  if (typeof entry !== "object" || entry === null) return "not an object.";
  const { key, name, type, config } = entry as Partial<MountConfig>;
  if (typeof key !== "string") return "missing key.";
  const keyError = validateKey(key, taken);
  if (keyError) return keyError;
  if (typeof name !== "string" || !name.trim()) return `mount "${key}" has no name.`;
  const mountType = typeof type === "string" ? types.get(type) : undefined;
  if (!mountType) return `mount "${key}" has an unknown type "${String(type)}".`;
  if (typeof config !== "object" || config === null) return `mount "${key}" has no config.`;
  const mounted = (entry as Partial<MountConfig>).mounted;
  if (mounted !== undefined && typeof mounted !== "boolean") {
    return `mount "${key}": "mounted" must be true or false.`;
  }
  for (const field of mountType.fields) {
    const value = (config as Record<string, unknown>)[field.name];
    if (field.kind === "secret") {
      if (value !== undefined)
        return `mount "${key}": the secret "${field.name}" belongs in the vault, not in settings.`;
    } else if (field.required && (typeof value !== "string" || !value)) {
      return `mount "${key}" is missing "${field.name}".`;
    }
  }
  return undefined;
}

/**
 * The `files.mounts` value to validate: the app's defaults only when the
 * setting is unset. A value that is set but malformed is passed on, so it is
 * reported, not silently replaced.
 */
export function mountsSetting(raw: unknown, defaults: MountConfig[]): unknown {
  return raw === undefined ? defaults : raw;
}

/** Absent or true: mounted. false: unmounted but remembered. */
export function isMounted(mount: MountConfig): boolean {
  return mount.mounted !== false;
}
