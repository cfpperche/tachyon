import type { Workspace } from "../workspace/Workspace.js";
import { FLAG_SUGGESTIONS, quickAddChips } from "./formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "./shared/studio/adapter.js";
import {
  AGENT_STUDIO_DOMAIN_MESSAGE_NAMES,
  agentFieldsFromDef,
  agentStudioTitleFor,
  blankAgentFields,
  canDiscardAgentFields,
  computeAgentDirty,
  serializeAgentPatch,
  validateAgentFields,
  type AgentStudioEntity,
  type AgentStudioFields,
  type AgentStudioPatch,
} from "./agent-studio-shell/domain.js";
import type { StudioValidationResult } from "./shared/studio/errorTaxonomy.js";

/**
 * spec 350 Phase 3 T1 — AgentStudioAdapter: the StudioHostAdapter<AgentStudioEntity,AgentStudioFields,
 * AgentStudioPatch> for the `agent` kind ONLY (the pilot). WRAPS formLogic.ts (via agent-studio-shell/
 * domain.ts) for validation and `Workspace.studioSubmit` (the SAME build-via-formLogic + YamlConfigEditor.
 * upsertAgent + full-config-revalidate-before-write path the legacy AgentForm already uses) for persistence
 * — no parallel write path, no change to either contract.
 *
 * Concurrency is `{kind:"none"}`: tachyon.yml is not CAS-versioned (last-write-wins is the existing 215
 * behavior for every studio dialect that writes it) — inventing CAS here would be a semantics change, out of
 * scope for this pilot.
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
      takenNames: deps.takenNames(),
    };
    if (entityId === undefined) {
      return { status: "ok", entity: { fields: blankAgentFields(), ...reference } };
    }
    const def = this.ws.config?.agents[entityId];
    if (!def || def.kind !== "agent") return { status: "not-found" };
    return { status: "ok", entity: { name: entityId, fields: agentFieldsFromDef(entityId, def), ...reference } };
  }

  /** Client-side instant Save-button gating (no `entityId` in this hook's signature, per the shell's adapter
   *  contract — see `StudioHostAdapter.validate`). `save()` below re-validates with the correct edit-mode
   *  `editingName` exclusion via `Workspace.studioSubmit`, which is the store-authoritative check. */
  validate(fields: AgentStudioFields): StudioValidationResult {
    return validateAgentFields(fields, this.ws.studioDeps().takenNames());
  }

  save(entityId: string | undefined, patch: AgentStudioPatch): StudioSaveResult {
    const errors = this.ws.studioSubmit({ state: patch, editingName: entityId });
    if (errors && errors.length > 0) {
      return { status: "error", error: { code: "validation/agent-save-failed", message: errors.join("; "), source: "validation" } };
    }
    return { status: "ok" };
  }
}
