import type { WorkspaceAgentStudioTarget } from "../shell/WorkspacePresentation.js";
import { mapStudioSubmitResult } from "./studioSubmit.js";
import { FLAG_SUGGESTIONS, fromDef, quickAddChips } from "./formLogic.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "./shared/studio/adapter.js";
import {
  AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES,
  agentStudioTitleFor,
  canonicalAgentFields,
  canDiscardAgentFields,
  computeAgentDirty,
  createAgentEvolutionLabels,
  createAgentProfileLabels,
  serializeAgentPatch,
  type AgentEvolutionLabels,
  type AgentProfileLabels,
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
  concurrency = { kind: "cas" as const };
  allowPatchRestore = true;
  dirty = { computeDirty: computeAgentDirty, serializePatch: serializeAgentPatch, canDiscard: canDiscardAgentFields };

  constructor(
    private readonly ws: WorkspaceAgentStudioTarget,
    private readonly evolutionLabels: AgentEvolutionLabels = createAgentEvolutionLabels(),
    private readonly persistentInstructionsHelp = "When supported, delivered at startup through the selected runtime.",
    private readonly profileLabels: AgentProfileLabels = createAgentProfileLabels(),
  ) {}

  titleFor(mode: "new" | "edit", entityId: string | undefined, entity: AgentStudioEntity | undefined): string {
    return agentStudioTitleFor(mode, entityId, entity);
  }

  revisionOf(entity: AgentStudioEntity): string {
    return entity.profile?.revision ?? "";
  }

  async load(entityId: string | undefined): Promise<StudioLoadResult<AgentStudioEntity>> {
    const deps = this.ws.studioDeps();
    const clis = await deps.detectClis();
    const reference = {
      chips: quickAddChips(clis),
      flagMap: FLAG_SUGGESTIONS,
      defaultCwd: deps.defaultCwd,
      verifyCandidates: deps.verifyCandidates(),
      persistentInstructionsHelp: this.persistentInstructionsHelp,
      evolutionLabels: this.evolutionLabels,
      profileLabels: this.profileLabels,
    };
    if (entityId === undefined) {
      return { status: "ok", entity: { storage: "canonical", fields: canonicalAgentFields(), ...reference } };
    }
    const def = this.ws.config?.agents[entityId];
    if (!def || def.kind !== "agent") return { status: "not-found" };
    if (def.profileLifecycle || def.profilePointer) {
      try {
        const profile = await this.ws.inspectAgentProfileStudio(entityId);
        return { status: "ok", entity: { name: entityId, storage: "canonical", profile, fields: canonicalAgentFields(profile), ...reference } };
      } catch (error) {
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { status: "ok", entity: { name: entityId, storage: "legacy", fields: fromDef(entityId, def), ...reference } };
  }

  validate(_fields: AgentStudioFields): StudioValidationResult {
    return NO_VALIDATION_ERRORS;
  }

  save(entityId: string | undefined, patch: AgentStudioPatch): StudioSaveResult | Promise<StudioSaveResult> {
    if (patch.kind === "canonical") {
      return this.ws.commitAgentProfileStudio(patch).then(
        () => ({ status: "ok" as const, ...(entityId === undefined ? { entityId: patch.agentName } : {}) }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return message.includes("revision conflict")
            ? { status: "conflict" as const, error: { code: "agent-profile/revision-conflict", message: "This profile changed. Reload before saving again." } }
            : { status: "error" as const, error: { code: "agent-profile/save-failed", message, source: "persistence" as const } };
        },
      );
    }
    return mapStudioSubmitResult(
      this.ws.studioSubmit({ state: patch, editingName: entityId }),
      "validation/agent-save-failed",
      entityId === undefined ? patch.name : undefined,
    );
  }

  /** Journaled common-path profile actions — authoritative host path for T15A protocol. */
  createSoulProfile(agent: string) { return this.ws.createSoulProfile(agent); }
  importSoulProfileBytes(agent: string, bytes: Buffer) { return this.ws.importSoulProfileBytes(agent, bytes); }
  replaceSoulProfileBytes(agent: string, bytes: Buffer, expectedDigest: string) { return this.ws.replaceSoulProfileBytes(agent, bytes, expectedDigest); }
  adoptSoulProfile(agent: string, expectedDigest: string) { return this.ws.adoptSoulProfile(agent, expectedDigest); }
  enableSoulProfile(agent: string) { return this.ws.enableSoulProfile(agent); }
  disableSoulProfile(agent: string) { return this.ws.disableSoulProfile(agent); }
  deleteSoulProfile(agent: string) { return this.ws.deleteSoulProfile(agent); }
  refreshSoulProfile(agent: string) { return this.ws.refreshSoulProfile(agent); }
}
