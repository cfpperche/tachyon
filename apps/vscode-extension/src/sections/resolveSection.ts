/**
 * spec 410 — pure section id resolution for cockpit nav + serializer restore.
 * Unknown / retired ids fall back to overview (asserted in unit tests).
 */
import { COCKPIT_SECTION_IDS, type SectionId } from "@tachyon/webview-ui/sections/model";

const SECTION_SET = new Set<string>(COCKPIT_SECTION_IDS);

/**
 * 514 — an installed app's id is not on `COCKPIT_SECTION_IDS` and never will be: that list is the
 * closed set of screens compiled into the product, and an app arrives from disk after the build.
 * Shape is all that can be checked here, and shape is enough — whether an `app:<id>` exists is a
 * question for the catalog, which answers it where the tile is drawn and where the panel is opened.
 * Accepting the shape here is what stops `openControl` from silently routing an app to System.
 */
const APP_SECTION = /^app:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Resolve a raw section from panel state, deep-link, or message. */
export function resolveSection(raw: unknown, fallback: SectionId = "overview"): SectionId {
  if (typeof raw !== "string" || !raw) return fallback;
  if (SECTION_SET.has(raw) || APP_SECTION.test(raw)) return raw as SectionId;
  return fallback;
}

export function isSectionId(raw: unknown): raw is SectionId {
  return typeof raw === "string" && (SECTION_SET.has(raw) || APP_SECTION.test(raw));
}

/** The installed app id behind an `app:<id>` section, or undefined for a built-in. */
export function appIdOfSection(raw: unknown): string | undefined {
  return typeof raw === "string" && APP_SECTION.test(raw) ? raw.slice("app:".length) : undefined;
}
