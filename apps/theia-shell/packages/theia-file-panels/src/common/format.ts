import { currentLocale } from "./locale";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** A file size in the largest unit below 1024, number and unit localized by Intl. */
export function formatSize(bytes: number, locale = currentLocale()): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** A modification time (ms since the epoch), short date and time. */
export function formatDate(mtime: number, locale = currentLocale()): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(mtime);
}

/** The CLDR plural category of `count` in `locale`. */
export function pluralCategory(count: number, locale = currentLocale()): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(count);
}
