import type { StudioError, StudioValidationResult } from "../shared/studio/errorTaxonomy";

/**
 * spec 350 T4 — Pipeline Studio (Fake 1): pure entity/fields/patch shapes + the adapter's declared dirty/
 * validation/title hooks. NO real pipeline semantics (Non-goal: "the real Pipeline Studio is its own spec,
 * on the shell, after this ships") — this proves the shell's full lifecycle against a fake, nothing more.
 *
 * Vscode-free by construction: both `PipelineStudioPanel.ts` (host) and `pipeline-studio/App.tsx` (webview)
 * import THIS module directly, so client-side save-gating feedback and the host's persistence-time
 * re-validation run the exact same logic — no risk of the two drifting apart.
 */

export interface PipelineStage {
  id: string;
  name: string;
}

export interface PipelineEntity {
  id: string;
  title: string;
  stages: PipelineStage[];
}

export type PipelineFields = { title: string; stages: PipelineStage[] };
export type PipelinePatch = PipelineFields;

export const PIPELINE_DOMAIN_MESSAGE_NAMES = ["importStages", "stagesImported"] as const;

export function emptyPipelineEntity(): PipelineEntity {
  return { id: "new", title: "", stages: [] };
}

export function computePipelineDirty(entity: PipelineEntity | undefined, fields: PipelineFields): boolean {
  const base = entity ?? emptyPipelineEntity();
  return base.title !== fields.title || JSON.stringify(base.stages) !== JSON.stringify(fields.stages);
}

export function serializePipelinePatch(fields: PipelineFields, dirty: boolean): PipelinePatch | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardPipelineFields(fields: PipelineFields): boolean {
  return fields.title.trim() === "" && fields.stages.length === 0;
}

export function pipelineTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: PipelineEntity | undefined): string {
  if (mode === "new") return "New Pipeline";
  return `Pipeline Studio — ${entity?.title || entityId || ""}`;
}

/** Store-authoritative validation (errorTaxonomy.ts): a title is required, stage names must be non-empty
 *  and unique. Both the webview (instant Save-button gating) and the host (persistence-time re-check in
 *  `save()`) call this SAME function — the taxonomy never has two independent implementations to drift. */
export function validatePipelineFields(fields: PipelineFields): StudioValidationResult {
  const blocking: StudioError[] = [];
  if (!fields.title.trim()) {
    blocking.push({ code: "validation/title-required", message: "Pipeline title is required", source: "validation", blocking: true });
  }
  const seen = new Set<string>();
  for (const stage of fields.stages) {
    const name = stage.name.trim();
    if (!name) {
      blocking.push({ code: "validation/stage-name-required", message: "Every stage needs a name", source: "validation", blocking: true });
      break;
    }
    if (seen.has(name)) {
      blocking.push({ code: "validation/duplicate-stage", message: `Duplicate stage name: "${name}"`, source: "validation", blocking: true });
      break;
    }
    seen.add(name);
  }
  return { blocking, nonBlocking: [] };
}

/** The one domain action Fake 1 exercises end-to-end (dueto F9's "domain actions" hook category): parses a
 *  pasted newline-separated list into stages, deduping/trimming — proving a REAL host round trip through the
 *  protocol's registered domain slot, not just the synthetic unit-test wiring in studioPanelBase.test.ts. */
export function parseImportedStages(raw: string, existing: readonly PipelineStage[]): PipelineStage[] {
  const seen = new Set(existing.map((s) => s.name.toLowerCase()));
  const added: PipelineStage[] = [];
  let seq = existing.length;
  for (const line of raw.split("\n")) {
    const name = line.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    seq += 1;
    added.push({ id: `stage-${seq}`, name });
  }
  return [...existing, ...added];
}
