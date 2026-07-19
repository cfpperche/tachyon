/**
 * spec 410 — pure section id resolution for cockpit nav + serializer restore.
 * Unknown / retired ids fall back to overview (asserted in unit tests).
 */
import { COCKPIT_SECTION_ORDER, type CockpitSectionId } from "./model.js";

const SECTION_SET = new Set<string>(COCKPIT_SECTION_ORDER);

/** Resolve a raw section from panel state, deep-link, or message. */
export function resolveCockpitSection(raw: unknown, fallback: CockpitSectionId = "overview"): CockpitSectionId {
  if (typeof raw !== "string" || !raw) return fallback;
  if (SECTION_SET.has(raw)) return raw as CockpitSectionId;
  return fallback;
}

export function isCockpitSectionId(raw: unknown): raw is CockpitSectionId {
  return typeof raw === "string" && SECTION_SET.has(raw);
}
