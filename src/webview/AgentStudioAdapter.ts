import type { Workspace } from "../workspace/Workspace.js";
import { FLAG_SUGGESTIONS, fromDef, quickAddChips } from "./formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "./shared/studio/adapter.js";
import {
  AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES,
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
 * spec 350 Phase 3 T1 + spec 377 T15A — AgentStudioAdapter for the `agent` kind.
 * Profile common-path mutations are journaled on Workspace (create/import/adopt/enable/disable);
 * this adapter exposes load/save plus thin typed accessors used by host tests.
 *
 * Concurrency for full-form save remains `{kind:"none"}` (legacy last-write-wins on tachyon.yml).
 * Profile mutations use a separate affected-stanza CAS inside the profile transaction journal.
 */
export class AgentStudioAdapter implements StudioHostAdapter<AgentStudioEntity, AgentStudioFields, AgentStudioPatch> {
  entityType = "agent";
  domainMessageNames = AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES;
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

  /** Journaled common-path profile actions — authoritative host path for T15A protocol. */
  createSoulProfile(agent: string) { return this.ws.createSoulProfile(agent); }
  importSoulProfile(agent: string, sourcePath: string) { return this.ws.importSoulProfile(agent, sourcePath); }
  adoptSoulProfile(agent: string, expectedDigest: string) { return this.ws.adoptSoulProfile(agent, expectedDigest); }
  enableSoulProfile(agent: string) { return this.ws.enableSoulProfile(agent); }
  disableSoulProfile(agent: string) { return this.ws.disableSoulProfile(agent); }
  refreshSoulProfile(agent: string) { return this.ws.refreshSoulProfile(agent); }
  canonicalSoulPath(agent: string) { return this.ws.canonicalSoulPath(agent); }
}
