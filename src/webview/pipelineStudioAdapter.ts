import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "./shared/studio/adapter.js";
import {
  PIPELINE_DOMAIN_MESSAGE_NAMES,
  canDiscardPipelineFields,
  computePipelineDirty,
  emptyPipelineEntity,
  pipelineTitleFor,
  serializePipelinePatch,
  validatePipelineFields,
  type PipelineEntity,
  type PipelineFields,
  type PipelinePatch,
} from "./pipeline-studio/domain.js";

/**
 * spec 350 T4 — the Pipeline Studio (Fake 1) host adapter: in-memory load/save/delete, no real persistence,
 * no vscode dependency (this whole module is dual-compilable — kept here rather than under pipeline-studio/
 * only because PipelineStudioPanel.ts, the true host file, is the natural place to own the Map; nothing
 * webview-side imports this file directly, it imports `./pipeline-studio/domain.js` instead).
 */
export function createPipelineStudioAdapter(store: Map<string, PipelineEntity>): StudioHostAdapter<PipelineEntity, PipelineFields, PipelinePatch> {
  let seq = store.size;
  return {
    entityType: "pipeline",
    domainMessageNames: PIPELINE_DOMAIN_MESSAGE_NAMES,
    concurrency: { kind: "none" },
    allowPatchRestore: true,
    dirty: { computeDirty: computePipelineDirty, serializePatch: serializePipelinePatch, canDiscard: canDiscardPipelineFields },
    titleFor: pipelineTitleFor,
    load(entityId): StudioLoadResult<PipelineEntity> {
      if (entityId === undefined) return { status: "ok", entity: emptyPipelineEntity() };
      const found = store.get(entityId);
      return found ? { status: "ok", entity: found } : { status: "not-found" };
    },
    validate: validatePipelineFields,
    save(entityId, patch): StudioSaveResult {
      const validation = validatePipelineFields(patch);
      if (validation.blocking.length > 0) {
        const first = validation.blocking[0]!;
        return { status: "error", error: { code: first.code, message: first.message, source: "validation" } };
      }
      const key = entityId ?? `pl-${++seq}`;
      store.set(key, { id: key, title: patch.title, stages: patch.stages });
      return { status: "ok" };
    },
    delete(entityId) {
      store.delete(entityId);
    },
  };
}
