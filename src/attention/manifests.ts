import type { ResumeRuntime } from "../resume/adapters.js";
import type { AttentionManifest, AttentionManifestRule } from "./manifestEngine.js";
import baseManifestData from "./manifests/base.json";
import grokOverlayData from "./manifests/grok.json";

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

export const ATTENTION_MANIFEST_RUNTIMES = ["claude", "codex", "grok", "opencode", "pi"] as const;
export type AttentionManifestRuntime = (typeof ATTENTION_MANIFEST_RUNTIMES)[number];

/**
 * Merges an optional per-runtime overlay onto the base manifest. Overlay rules replace a
 * base rule sharing its `id` in place, or extend the rule set by appending a new id.
 */
export function resolveManifest(base: BaseAttentionManifest, overlay: ManifestOverlay | undefined, runtime: ResumeRuntime): AttentionManifest {
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

export function attentionManifestForRuntime(runtime: ResumeRuntime | null | undefined): AttentionManifest {
  const rt = runtime ?? "claude";
  return resolveManifest(BASE_MANIFEST, OVERLAYS[rt], rt);
}
