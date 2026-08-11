/**
 * SDD 490 Fatia A — **moment zero**: the one production door that creates a
 * `FormationAuthorityVector` where none exists.
 *
 * ## Why this file exists at all
 *
 * `authorityStore.ts` has always been able to publish generation 1 (`mutation: "bootstrap"`), and the
 * only production store that ever opened it is the spawn path's, which is deliberately read-only
 * (`lifecycleHost.ts` — `authorizeMutation: () => false`). So the mutation existed and nothing could
 * reach it, which is why persistent instructions delivered to no agent when this lane shipped.
 *
 * The 490 review (C2) named the trap precisely: `HumanLaneTransactionService` cannot be that door,
 * because every one of its paths reads `currentVector` first and throws a CAS mismatch without one.
 * It is the editor that runs AFTER moment zero. Naming it "the only publisher" would have been
 * satisfiable by something that never bootstraps, while a raw `store.replaceVector(...)` call
 * elsewhere adopted with no custody and no audit at all.
 *
 * ## What "the human put it there" can honestly mean here
 *
 * The spec asks the door to authenticate a human actor. **This repository cannot do that, and this
 * door does not pretend to.** Measured on 2026-08-05:
 *
 * - `engine-service/controlPeerAuth.ts` proves *same-uid*, not humanity: the nonce is a `0600` file
 *   and the check is `stat.uid === process.getuid()`. Every agent Tachyon spawns runs as that uid.
 * - `bridge/callerIdentity.ts` cannot mint one: `resolveCaller` produces only `agent | legacy |
 *   external` from a Bearer, and its own contract reserves `human` for "an internal host-only call
 *   path".
 *
 * So the property this door actually holds is **UNREACHABILITY, not authentication**. It is not that
 * we verify who is calling; it is that the surfaces an agent can reach have no route here:
 *
 * - not an `ExtensionCommandV1` action, so `extension.invoke` over the control socket cannot name it;
 * - not a `vscode.commands.registerCommand` id, because the shell's UI handler executes **any**
 *   command id the daemon asks for (`extension.ts` — `vscode.commands.executeCommand(request.command,
 *   ...)`), which would put an agent one control request away;
 * - not on `WorkspaceAgentStudioTarget`, so the remote studio client has nothing to build a route
 *   from — the interface is exactly the pressure that would otherwise push it onto the socket.
 *
 * `test/unit/agentFormationBootstrap.test.ts` fails if any of those three appears, and fails if a
 * second `mutation: "bootstrap"` call site appears anywhere in `src/`.
 *
 * **The residue, stated plainly:** an actor with code execution inside the extension host is
 * indistinguishable from the human. Nothing here closes that, and nothing here should be read as
 * closing it.
 */

import { parseDocument } from "yaml";
import {
  FormationAuthorityStoreError,
  type FormationAuthorityStore,
  type FormationCaller,
  type FormationMutationReceipt,
} from "./authorityStore.js";
import {
  formationDigest,
  validateFormationAuthorityVector,
  type FormationAuthorityVector,
  type FormationLane,
  type ProfileActivationHeadV2,
} from "./domain.js";
import {
  HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
  HUMAN_INSTRUCTIONS_RENDERER_CONTRACT,
  HUMAN_INSTRUCTIONS_RENDERER_SHA256,
} from "./humanLanes.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile } from "../../config/agentProfileReader.js";
import { agentProfileSchemaV1, type AgentProfileV1 } from "../../config/agentProfileSchema.js";
import { resolvePersistentInstructions } from "../persistentInstructions.js";

/** The conventional sources the human lanes read; adoption binds these exact paths or refuses. */
const INSTRUCTIONS_SOURCE_PATH = "instructions.md";

export class FormationBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormationBootstrapError";
  }
}

export interface FormationRuntimeInspector {
  adapter: string;
  id: string;
  version: string;
  sha256: string;
}

export interface FormationAdoptionInput {
  operationId: string;
  /** Must be `kind: "human"`. The host's `authorizeMutation` says so too; this repeats it at the door. */
  caller: FormationCaller;
  workspaceId: string;
  workspaceRoot: string;
  agentName: string;
  /** Host-custodied profile head (`AgentProfileAuthorityRecord.runtimeInspector`). */
  runtimeInspector: FormationRuntimeInspector;
  /** The resolved effective-profile digest (`agentSources[name].effectiveSha256`). */
  effectiveSha256: string;
  /**
   * The `agent.yml` digest the human was looking at. Adoption refuses if the bytes moved since —
   * "from which bytes" is only meaningful if the answer is the bytes they saw.
   */
  expectedProfileSha256?: string;
}

/** What adoption bound, in the terms a human reads back: who, when, and from which bytes. */
export interface FormationAdoptionRecord {
  vector: FormationAuthorityVector;
  receipt: FormationMutationReceipt;
  source: {
    agentId: string;
    agentName: string;
    workspaceId: string;
    profileSha256: string;
    instructionsSha256?: string;
  };
}

export type FormationAdoptionState =
  | { state: "not-a-profile-agent" }
  | { state: "unadopted"; agentId: string; profileSha256: string; adoptable: boolean; reason?: string }
  | { state: "adopting"; agentId: string; operationId: string }
  | { state: "adopted"; agentId: string; vector: FormationAuthorityVector };

interface BoundLanes {
  instructions: FormationLane;
  instructionsSha256?: string;
}

function assertHuman(caller: FormationCaller): void {
  if (caller.kind !== "human") {
    throw new FormationBootstrapError(
      `formation adoption is a human act; a '${caller.kind}' caller cannot place an agent under authority`,
    );
  }
}

function parseProfile(text: string, source: string): AgentProfileV1 {
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) throw new FormationBootstrapError(`canonical agent profile is not valid YAML: ${source}`);
  const parsed = agentProfileSchemaV1.safeParse(document.toJS());
  if (!parsed.success) throw new FormationBootstrapError(`canonical agent profile is invalid: ${source}`);
  return parsed.data;
}

export class FormationBootstrapService {
  constructor(private readonly store: FormationAuthorityStore) {}

  /**
   * Publish generation 1 for an agent that has none.
   *
   * Atomic in the sense that matters: the vector row is written inside one `BEGIN IMMEDIATE`
   * transaction, and the surrounding barrier/receipt bracket makes an interrupted run recoverable and
   * a repeat of the same `operationId` a replay rather than a second generation. Two concurrent
   * adoptions cannot both win — the second reads a present row and fails the bootstrap CAS.
   *
   * Adoption writes **nothing** to the workspace. It reads the bytes already on disk and binds their
   * digests, which is what keeps SDD 427's "workspace bytes cannot activate themselves" true: the
   * file supplies content, the human supplies the act, and neither substitutes for the other.
   */
  async adopt(input: FormationAdoptionInput): Promise<FormationAdoptionRecord> {
    assertHuman(input.caller);

    const replayed = this.store.mutationReceipt(input.operationId, input.caller);
    if (replayed) {
      if (replayed.mutation !== "bootstrap" || replayed.outcome !== "committed") {
        throw new FormationBootstrapError("formation adoption operation is already terminal with another outcome");
      }
      const current = this.store.currentVector(replayed.agentId);
      if (!current || formationDigest(current.generation) !== replayed.nextGenerationSha256) {
        throw new FormationBootstrapError("committed formation adoption authority is unavailable");
      }
      return { vector: current, receipt: replayed, source: this.sourceOf(current) };
    }

    const { profile, profileSha256 } = this.readProfile(input.workspaceRoot, input.agentName, input.expectedProfileSha256);
    const agentId = profile.agentId;
    if (this.store.currentVector(agentId)) {
      throw new FormationBootstrapError(`agent '${input.agentName}' is already under formation authority`);
    }
    if (input.runtimeInspector.adapter !== profile.runtime.adapter) {
      throw new FormationBootstrapError(
        `runtime inspector names adapter '${input.runtimeInspector.adapter}' but the profile declares '${profile.runtime.adapter}'`,
      );
    }

    const lanes = await this.bindLanes(input.workspaceRoot, input.agentName, agentId, profile, profileSha256);
    const vector = buildGenerationOne({
      workspaceId: input.workspaceId,
      agentId,
      agentName: input.agentName,
      profileSha256,
      effectiveSha256: input.effectiveSha256,
      runtimeInspector: input.runtimeInspector,
      lanes,
    });
    const errors = validateFormationAuthorityVector(vector);
    if (errors.length > 0) throw new FormationBootstrapError(`adopted formation vector is invalid: ${errors.join("; ")}`);

    // The barrier is the durable "who/when/from-which-bytes" record. Its intent is read back by
    // `recover`, so an interrupted adoption is resolvable without guessing.
    this.store.beginMutationBarrier({
      operationId: input.operationId,
      mutation: "bootstrap",
      caller: input.caller,
      workspaceId: input.workspaceId,
      agentId,
      intent: {
        schemaVersion: 1,
        kind: "formation-adoption",
        agentName: input.agentName,
        agentId,
        profileSha256,
        ...(lanes.instructionsSha256 ? { instructionsSha256: lanes.instructionsSha256 } : {}),
        nextVector: vector,
      },
    });
    this.store.replaceVector({
      operationId: input.operationId,
      caller: input.caller,
      mutation: "bootstrap",
      vector,
    });
    // Adoption publishes no source bytes, so "source-published" is passed through rather than done.
    this.store.advanceMutationBarrier({ operationId: input.operationId, caller: input.caller, expectedPhase: "prepared", phase: "source-published" });
    this.store.advanceMutationBarrier({ operationId: input.operationId, caller: input.caller, expectedPhase: "source-published", phase: "authority-committed" });
    this.store.finishMutationBarrier({
      operationId: input.operationId,
      caller: input.caller,
      outcome: "committed",
      nextGenerationSha256: formationDigest(vector.generation),
    });
    const receipt = this.store.mutationReceipt(input.operationId, input.caller);
    if (!receipt) throw new FormationBootstrapError("formation adoption committed without a durable receipt");
    return { vector, receipt, source: this.sourceOf(vector, lanes) };
  }

  /**
   * Resolve an adoption interrupted between its barrier and its receipt.
   *
   * Adoption touches no workspace file, so rollback is simply "there is no generation 1" — there is
   * nothing on disk to put back. That is why this is a much shorter machine than the human-lane one.
   */
  recover(agentId: string, caller: FormationCaller): "none" | "rolled-back" | "completed" {
    assertHuman(caller);
    const barrier = this.store.mutationBarrier(agentId, caller);
    if (!barrier) return "none";
    if (barrier.mutation !== "bootstrap") return "none";
    const intent = barrier.intent as { nextVector?: FormationAuthorityVector } | undefined;
    const current = this.store.currentVector(agentId);
    if (current && intent?.nextVector && formationDigest(current.generation) === formationDigest(intent.nextVector.generation)) {
      if (barrier.phase === "prepared") {
        this.store.advanceMutationBarrier({ operationId: barrier.operationId, caller, expectedPhase: "prepared", phase: "source-published" });
      }
      if (barrier.phase !== "authority-committed") {
        this.store.advanceMutationBarrier({ operationId: barrier.operationId, caller, expectedPhase: "source-published", phase: "authority-committed" });
      }
      this.store.finishMutationBarrier({
        operationId: barrier.operationId,
        caller,
        outcome: "committed",
        nextGenerationSha256: formationDigest(current.generation),
      });
      return "completed";
    }
    if (current) throw new FormationBootstrapError("formation adoption recovery found an unrelated authority generation");
    this.store.finishMutationBarrier({ operationId: barrier.operationId, caller, outcome: "rolled-back" });
    return "rolled-back";
  }

  /**
   * What Agent Studio needs to be honest rather than inert: whether this agent has authority yet,
   * and — when it does not — whether adopting it would work and what stands in the way if not.
   */
  async inspect(input: { workspaceRoot: string; agentName: string; caller: FormationCaller }): Promise<FormationAdoptionState> {
    let profileSha256: string;
    let profile: AgentProfileV1;
    try {
      const read = this.readProfile(input.workspaceRoot, input.agentName);
      profile = read.profile;
      profileSha256 = read.profileSha256;
    } catch {
      return { state: "not-a-profile-agent" };
    }
    const vector = this.store.currentVector(profile.agentId);
    if (vector) return { state: "adopted", agentId: profile.agentId, vector };
    const barrier = this.store.mutationBarrier(profile.agentId, input.caller);
    if (barrier) return { state: "adopting", agentId: profile.agentId, operationId: barrier.operationId };
    try {
      await this.bindLanes(input.workspaceRoot, input.agentName, profile.agentId, profile, profileSha256);
      return { state: "unadopted", agentId: profile.agentId, profileSha256, adoptable: true };
    } catch (error) {
      return {
        state: "unadopted",
        agentId: profile.agentId,
        profileSha256,
        adoptable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readProfile(workspaceRoot: string, agentName: string, expectedSha256?: string): { profile: AgentProfileV1; profileSha256: string } {
    const source = readCanonicalAgentProfile(workspaceRoot, agentName);
    if (!source) throw new FormationBootstrapError(`agent '${agentName}' has no canonical profile to adopt`);
    try {
      if (expectedSha256 !== undefined && source.sha256 !== expectedSha256) {
        throw new FormationBootstrapError("agent.yml changed since it was read; refresh Agent Studio and adopt again");
      }
      return { profile: parseProfile(source.text, source.source), profileSha256: source.sha256 };
    } finally {
      closeCanonicalAgentProfile(source);
    }
  }

  /**
   * Derive the instructions lane from the bytes already on disk.
   *
   * A declared lane that cannot be bound is a REFUSAL, never a quiet `disabled`. Adopting an agent
   * A declared lane that cannot be bound is a refusal, never a quiet disabled result.
   */
  private async bindLanes(
    workspaceRoot: string,
    agentName: string,
    agentId: string,
    profile: AgentProfileV1,
    profileSha256: string,
  ): Promise<BoundLanes> {
    const bound: BoundLanes = { instructions: { mode: "disabled" } };

    const instructionsReferenceId = profile.prompt?.instructions;
    if (instructionsReferenceId !== undefined) {
      const reference = profile.references?.find((candidate) => candidate.id === instructionsReferenceId);
      if (!reference || reference.kind !== "instructions" || reference.scope !== "profile"
        || reference.owner !== agentId || reference.path !== INSTRUCTIONS_SOURCE_PATH || !reference.sha256) {
        throw new FormationBootstrapError(
          `Persistent Instructions reference '${instructionsReferenceId}' must be a profile-owned pinned '${INSTRUCTIONS_SOURCE_PATH}'`,
        );
      }
      const resolved = resolvePersistentInstructions({
        workspaceRoot,
        agentName,
        agentId,
        referenceId: reference.id,
        // `validateNextProfile` requires selector and subject to be the same id for this lane.
        subjectId: reference.id,
        expectedPath: INSTRUCTIONS_SOURCE_PATH,
        expectedProfileSha256: profileSha256,
        expectedSha256: reference.sha256,
      });
      bound.instructions = {
        mode: "profile",
        required: true,
        selectorId: reference.id,
        subjectId: reference.id,
        path: INSTRUCTIONS_SOURCE_PATH,
        sourceSha256: resolved.sha256,
        rendererContract: HUMAN_INSTRUCTIONS_RENDERER_CONTRACT,
        rendererSha256: HUMAN_INSTRUCTIONS_RENDERER_SHA256,
      };
      bound.instructionsSha256 = resolved.sha256;
    }

    if (bound.instructions.mode !== "profile") {
      throw new FormationBootstrapError(
        `agent '${agentName}' declares no Persistent Instructions lane, so there is nothing to place under authority`,
      );
    }
    return bound;
  }

  private sourceOf(vector: FormationAuthorityVector, lanes?: BoundLanes): FormationAdoptionRecord["source"] {
    const instructions = vector.profile.lanes.instructions;
    return {
      agentId: vector.profile.agentId,
      agentName: vector.profile.agentName,
      workspaceId: vector.profile.workspaceId,
      profileSha256: vector.profile.canonicalSha256,
      ...(instructions.mode === "profile"
        ? { instructionsSha256: instructions.sourceSha256 }
        : lanes?.instructionsSha256 ? { instructionsSha256: lanes.instructionsSha256 } : {}),
    };
  }
}

/**
 * Generation 1, and only generation 1.
 *
 * The memory lane stays `disabled` even though `validateVectorTransition` would permit an initial
 * head for it at bootstrap. That lane has its own promotion publisher, and it presupposes an active
 * vector; letting adoption author it would be a second way to author it.
 */
function buildGenerationOne(input: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  profileSha256: string;
  effectiveSha256: string;
  runtimeInspector: FormationRuntimeInspector;
  lanes: BoundLanes;
}): FormationAuthorityVector {
  const profile: ProfileActivationHeadV2 = {
    schemaVersion: 2,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    agentName: input.agentName,
    revision: 1,
    priorRevision: 0,
    canonicalSha256: input.profileSha256,
    effectiveSha256: input.effectiveSha256,
    runtimeInspector: { ...input.runtimeInspector },
    lanes: {
      instructions: input.lanes.instructions,
      memory: { mode: "disabled" },
    },
  };
  return {
    profile,
    generation: {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      generation: 1,
      priorGeneration: 0,
      retired: false,
      profile: { revision: 1, digest: formationDigest(profile) },
      rendererContractsSha256: HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256,
    },
  };
}

/** Re-exported so callers can distinguish a store refusal from a door refusal without importing both. */
export { FormationAuthorityStoreError };
