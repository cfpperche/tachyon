import type { Workspace } from "../workspace/Workspace.js";
import { FLAG_SUGGESTIONS, fromDef, quickAddChips } from "./formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "./shared/studio/adapter.js";
import {
  AGENT_STUDIO_DOMAIN_MESSAGE_NAMES,
  agentStudioTitleFor,
  blankAgentFields,
  canDiscardAgentFields,
  computeAgentDirty,
  serializeAgentPatch,
  type AgentStudioEntity,
  type AgentStudioFields,
  type AgentStudioPatch,
} from "./agent-studio-shell/domain.js";
import { NO_VALIDATION_ERRORS, type StudioValidationResult } from "./shared/studio/errorTaxonomy.js";

/**
 * spec 350 Phase 3 T1 — AgentStudioAdapter: the StudioHostAdapter<AgentStudioEntity,AgentStudioFields,
 * AgentStudioPatch> for the `agent` kind ONLY (the pilot). WRAPS formLogic.ts (`fromDef` for edit-mode load)
 * and `Workspace.studioSubmit` (the SAME build-via-formLogic + YamlConfigEditor.upsertAgent + full-config-
 * revalidate-before-write path the legacy AgentForm already uses) for persistence — no parallel write path,
 * no change to either contract. formLogic.ts's runtime is imported HERE, not from agent-studio-shell/domain.ts
 * — that module is shared with the browser bundle, and formLogic.ts transitively pulls in `node:fs` via
 * config/loadConfig.ts (confirmed empirically: esbuild's browser target can't resolve it).
 *
 * Concurrency is `{kind:"none"}`: tachyon.yml is not CAS-versioned (last-write-wins is the existing 215
 * behavior for every studio dialect that writes it) — inventing CAS here would be a semantics change, out of
 * scope for this pilot.
 *
 * `validate()` returns `NO_VALIDATION_ERRORS` — same precedent as TaskStudioAdapter (spec 350 T1): the legacy
 * Agent Studio never client-side-gated Save on field content either (its `errors` state is populated only
 * from the host's response to a submit attempt, not live per-keystroke); `save()`'s `Workspace.studioSubmit`
 * call is the single authoritative validate-and-write path, unchanged from before this migration.
 *
 * Edit-mode `load()` only resolves entries whose `def.kind === "agent"` — a `terminals:`-block entry (or an
 * agents: entry with `kind: terminal`) reports `not-found` here on purpose. Coexistence means Terminal edits
 * stay on the legacy AgentForm; this adapter never silently reinterprets a Terminal as an Agent.
 */
export class AgentStudioAdapter implements StudioHostAdapter<AgentStudioEntity, AgentStudioFields, AgentStudioPatch> {
  entityType = "agent";
  domainMessageNames = AGENT_STUDIO_DOMAIN_MESSAGE_NAMES;
  concurrency = { kind: "none" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeAgentDirty, serializePatch: serializeAgentPatch, canDiscard: canDiscardAgentFields };

  constructor(private readonly ws: Workspace) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: AgentStudioEntity | undefined): string {
    return agentStudioTitleFor(mode, entityId, entity);
  }

  async load(entityId: string | undefined): Promise<StudioLoadResult<AgentStudioEntity>> {
    const deps = this.ws.studioDeps();
    const clis = await deps.detectClis();
    const reference = {
      chips: quickAddChips(clis),
      flagMap: FLAG_SUGGESTIONS,
      defaultCwd: deps.defaultCwd,
      verifyCandidates: deps.verifyCandidates(),
    };
    if (entityId === undefined) {
      return { status: "ok", entity: { fields: blankAgentFields(), ...reference } };
    }
    const def = this.ws.config?.agents[entityId];
    if (!def || def.kind !== "agent") return { status: "not-found" };
    return { status: "ok", entity: { name: entityId, fields: fromDef(entityId, def), ...reference } };
  }

  validate(_fields: AgentStudioFields): StudioValidationResult {
    return NO_VALIDATION_ERRORS;
  }

  save(entityId: string | undefined, patch: AgentStudioPatch): StudioSaveResult {
    const errors = this.ws.studioSubmit({ state: patch, editingName: entityId });
    if (errors && errors.length > 0) {
      return { status: "error", error: { code: "validation/agent-save-failed", message: errors.join("; "), source: "validation" } };
    }
    return { status: "ok" };
  }
}
