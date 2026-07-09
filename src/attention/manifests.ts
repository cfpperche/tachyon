import type { ResumeRuntime } from "../resume/adapters.js";
import type { AttentionManifest } from "./manifestEngine.js";
import claudeManifest from "./manifests/claude.json";
import codexManifest from "./manifests/codex.json";
import grokManifest from "./manifests/grok.json";
import opencodeManifest from "./manifests/opencode.json";

const MANIFESTS: Partial<Record<ResumeRuntime, AttentionManifest>> = {
  claude: claudeManifest as AttentionManifest,
  codex: codexManifest as AttentionManifest,
  grok: grokManifest as AttentionManifest,
  opencode: opencodeManifest as AttentionManifest,
};

export const ATTENTION_MANIFEST_RUNTIMES = ["claude", "codex", "grok", "opencode"] as const;
export type AttentionManifestRuntime = (typeof ATTENTION_MANIFEST_RUNTIMES)[number];

export function attentionManifestForRuntime(runtime: ResumeRuntime | null | undefined): AttentionManifest {
  return MANIFESTS[runtime ?? "claude"] ?? MANIFESTS.claude!;
}
