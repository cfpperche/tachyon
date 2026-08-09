/**
 * spec 410 — pure section id resolution for cockpit nav + serializer restore.
 * Unknown / retired ids fall back to overview (asserted in unit tests).
 */
import { COCKPIT_SECTION_IDS, type SectionId } from "./model.js";

const SECTION_SET = new Set<string>(COCKPIT_SECTION_IDS);

/** Resolve a raw section from panel state, deep-link, or message. */
export function resolveSection(raw: unknown, fallback: SectionId = "overview"): SectionId {
  if (typeof raw !== "string" || !raw) return fallback;
  if (SECTION_SET.has(raw)) return raw as SectionId;
  return fallback;
}

export function isSectionId(raw: unknown): raw is SectionId {
  return typeof raw === "string" && SECTION_SET.has(raw);
}
