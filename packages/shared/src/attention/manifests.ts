import type { ResumeRuntime } from "../resume/adapters.js";
import type { AttentionManifest, AttentionManifestRule, AttentionManifestScope } from "./manifestEngine.js";
import baseManifestData from "./manifests/base.json";
import grokOverlayData from "./manifests/grok.json";
import neutralOverlayData from "./manifests/neutral.json";

/**
 * `base.json` holds today's rules: ported verbatim from the runtime-agnostic patterns.ts,
 * not per-runtime measured. A runtime overlay may extend/override base rules by id once a
 * runtime's chrome has actually been measured (see `resolveManifest`).
 */
export type BaseAttentionManifest = Omit<AttentionManifest, "runtime">;

export interface ManifestOverlay {
  version?: string;
  evidence: string;
  rules: AttentionManifestRule[];
}

export const BASE_MANIFEST = baseManifestData as BaseAttentionManifest;

// Add `<runtime>.json` here (with the measured CLI version + evidence) as overlays land.
// t-4e6ba5: grok is the first. Its native tool-authorization modal shares no signature with any base
// rule, and the pane keeps animating while the modal waits — so without this the agent read `working`,
// no coordinator was notified, and governed input was refused as busy.
const OVERLAYS: Partial<Record<ResumeRuntime, ManifestOverlay>> = {
  grok: grokOverlayData as ManifestOverlay,
};

/**
 * t-c59600 — the overlay for entries that declare NO runtime. Deliberately NOT a member of
 * OVERLAYS: that map is keyed by ResumeRuntime, and the whole point is that `neutral` is not a
 * runtime and must never be reachable by a runtime lookup that happens to be handed `undefined`.
 */
export const NEUTRAL_OVERLAY = neutralOverlayData as ManifestOverlay;

export const ATTENTION_MANIFEST_RUNTIMES = ["claude", "codex", "grok", "opencode", "pi"] as const;
export type AttentionManifestRuntime = (typeof ATTENTION_MANIFEST_RUNTIMES)[number];

/**
 * Merges an optional per-runtime overlay onto the base manifest. Overlay rules replace a
 * base rule sharing its `id` in place, or extend the rule set by appending a new id.
 */
export function resolveManifest(base: BaseAttentionManifest, overlay: ManifestOverlay | undefined, runtime: AttentionManifestScope): AttentionManifest {
  if (!overlay) return { ...base, runtime };
  const rulesById = new Map(base.rules.map((rule) => [rule.id, rule] as const));
  for (const rule of overlay.rules) rulesById.set(rule.id, rule);
  return {
    version: overlay.version ?? base.version,
    runtime,
    evidence: `${base.evidence} Overlay (${runtime}): ${overlay.evidence}`,
    rules: [...rulesById.values()],
  };
}

/**
 * t-c59600 — a MISSING runtime resolves the neutral manifest, not claude's.
 *
 * The old body was `runtime ?? "claude"`, which made "nothing declared" indistinguishable from
 * "claude declared". Nothing observable diverged while OVERLAYS held no `claude` entry — both
 * arms resolved BASE, and that was measured on both sides before this change — but the naming was
 * a claim nobody made and the leak was one file away: the day a measured `claude.json` lands,
 * every `kind: terminal` pane in the fleet would silently start being read as a Claude TUI.
 *
 * `null` and `undefined` mean the same thing here on purpose: `cmdOf` returns null for a terminal
 * (Workspace.ts:1468) and AttentionMonitor's `manifestRuntimeFromCmd` turns that into undefined,
 * so both spellings of "no runtime" arrive at this door.
 */
export function attentionManifestForRuntime(runtime: ResumeRuntime | null | undefined): AttentionManifest {
  if (!runtime) return resolveManifest(BASE_MANIFEST, NEUTRAL_OVERLAY, "neutral");
  return resolveManifest(BASE_MANIFEST, OVERLAYS[runtime], runtime);
}
