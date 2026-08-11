import { SelectedMemoryStore, type SelectedMemoryPromotionToken } from "../../memory/SelectedMemoryStore.js";
import { selectedMemoryActiveDigest } from "../../memory/domain.js";
import {
  FormationAuthorityStore,
  FormationAuthorityStoreError,
  type FormationCaller,
  type FormationMutationBarrier,
} from "./authorityStore.js";
import { formationDigest, validateFormationAuthorityVector, type FormationAuthorityVector } from "./domain.js";
import { memoryActivationHeadForState } from "./memoryLane.js";

interface MemoryPromotionIntent {
  schemaVersion: 1;
  kind: "selected-memory-promotion";
  workspaceId: string;
  agentId: string;
  agentName: string;
  expectedGenerationSha256: string;
  token: SelectedMemoryPromotionToken;
  nextVector: FormationAuthorityVector;
}

function parseIntent(barrier: FormationMutationBarrier): MemoryPromotionIntent {
  const intent = barrier.intent as Partial<MemoryPromotionIntent> | undefined;
  if (!intent || intent.schemaVersion !== 1 || intent.kind !== "selected-memory-promotion"
    || typeof intent.workspaceId !== "string" || typeof intent.agentId !== "string" || typeof intent.agentName !== "string"
    || typeof intent.expectedGenerationSha256 !== "string" || !intent.token || !intent.nextVector
    || barrier.mutation !== "memory-promotion" || barrier.workspaceId !== intent.workspaceId
    || barrier.agentId !== intent.agentId || barrier.expectedGenerationSha256 !== intent.expectedGenerationSha256
    || validateFormationAuthorityVector(intent.nextVector).length > 0
    || intent.nextVector.profile.agentId !== intent.agentId || intent.nextVector.profile.agentName !== intent.agentName
    || intent.token.agentId !== intent.agentId || intent.token.agentName !== intent.agentName) {
    throw new FormationAuthorityStoreError("selected-memory promotion intent is corrupt or mismatched");
  }
  return intent as MemoryPromotionIntent;
}

export class SelectedMemoryFormationTransactionService {
  constructor(private readonly formationStore: FormationAuthorityStore, private readonly memoryStore: SelectedMemoryStore) {}

  async preparePromotion(input: {
    operationId: string;
    caller: FormationCaller;
    workspaceId: string;
    agentId: string;
    agentName: string;
    candidateId: string;
    expectedGenerationSha256: string;
    expectedMemoryVersion: number;
    expectedCandidateSha256: string;
  }): Promise<FormationMutationBarrier> {
    if (input.caller.kind !== "human") throw new FormationAuthorityStoreError("selected-memory promotion requires a human caller");
    const current = this.formationStore.currentVector(input.agentId);
    if (!current || !current.memory || current.generation.retired
      || formationDigest(current.generation) !== input.expectedGenerationSha256
      || current.profile.workspaceId !== input.workspaceId || current.profile.agentName !== input.agentName
      || current.profile.lanes.memory.mode !== "profile") {
      throw new FormationAuthorityStoreError("selected-memory promotion does not match active formation authority");
    }
    const token = await this.memoryStore.preparePromotion(input.agentName, input.candidateId, {
      expectedVersion: input.expectedMemoryVersion,
      expectedCandidateSha256: input.expectedCandidateSha256,
      approvedBy: input.caller.principal,
    });
    if (!this.memoryStore.verifyPromotionToken(token) || token.activationId !== current.memory.activationId) {
      throw new FormationAuthorityStoreError("selected-memory store returned an invalid promotion authorization");
    }
    const prior = await this.memoryStore.readActiveState(input.agentName);
    if (selectedMemoryActiveDigest(prior) !== token.priorActiveSha256) {
      throw new FormationAuthorityStoreError("selected-memory active source changed before preparation");
    }
    const nextHead = memoryActivationHeadForState({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      profileRevision: current.profile.revision,
      revision: current.memory.revision + 1,
      priorRevision: current.memory.revision,
      active: token.nextActive,
    });
    const nextVector: FormationAuthorityVector = {
      profile: structuredClone(current.profile),
      memory: nextHead,
      generation: {
        ...structuredClone(current.generation),
        generation: current.generation.generation + 1,
        priorGeneration: current.generation.generation,
        memory: { revision: nextHead.revision, digest: formationDigest(nextHead) },
      },
    };
    return this.formationStore.beginMutationBarrier({
      operationId: input.operationId,
      mutation: "memory-promotion",
      caller: input.caller,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      expectedGenerationSha256: input.expectedGenerationSha256,
      intent: {
        schemaVersion: 1,
        kind: "selected-memory-promotion",
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        agentName: input.agentName,
        expectedGenerationSha256: input.expectedGenerationSha256,
        token,
        nextVector,
      } satisfies MemoryPromotionIntent,
    });
  }

  async commit(input: {
    operationId: string;
    caller: FormationCaller;
    agentId: string;
    afterSourcePublished?: () => void;
    afterAuthorityCommitted?: () => void;
  }): Promise<FormationAuthorityVector> {
    const receipt = this.formationStore.mutationReceipt(input.operationId, input.caller);
    if (receipt) {
      const current = this.formationStore.currentVector(input.agentId);
      if (receipt.outcome !== "committed" || !current || formationDigest(current.generation) !== receipt.nextGenerationSha256) {
        throw new FormationAuthorityStoreError("selected-memory promotion is terminal with another outcome");
      }
      return current;
    }
    const barrier = this.formationStore.mutationBarrier(input.agentId, input.caller);
    if (!barrier || barrier.operationId !== input.operationId) throw new FormationAuthorityStoreError("selected-memory promotion barrier is unavailable");
    const intent = parseIntent(barrier);
    if (!this.memoryStore.verifyPromotionToken(intent.token)) throw new FormationAuthorityStoreError("selected-memory promotion authorization is invalid");
    if (barrier.phase === "prepared") {
      const before = selectedMemoryActiveDigest(await this.memoryStore.readActiveState(intent.agentName));
      if (before === intent.token.priorActiveSha256 || before === intent.token.nextActiveSha256) {
        await this.memoryStore.publishPreparedPromotion(intent.token);
      } else throw new FormationAuthorityStoreError("selected-memory source changed before publication");
      if (selectedMemoryActiveDigest(await this.memoryStore.readActiveState(intent.agentName)) !== intent.token.nextActiveSha256) {
        throw new FormationAuthorityStoreError("selected-memory source did not publish the authorized inventory");
      }
      this.formationStore.advanceMutationBarrier({ operationId: input.operationId, caller: input.caller, expectedPhase: "prepared", phase: "source-published" });
      input.afterSourcePublished?.();
    }
    if (selectedMemoryActiveDigest(await this.memoryStore.readActiveState(intent.agentName)) !== intent.token.nextActiveSha256) {
      throw new FormationAuthorityStoreError("selected-memory inventory changed before authority commit");
    }
    const current = this.formationStore.currentVector(intent.agentId);
    if (!current || formationDigest(current.generation) !== formationDigest(intent.nextVector.generation)) {
      this.formationStore.replaceVector({
        operationId: input.operationId,
        caller: input.caller,
        mutation: "memory-promotion",
        vector: intent.nextVector,
        expectedGenerationSha256: intent.expectedGenerationSha256,
      });
    }
    const after = this.formationStore.mutationBarrier(input.agentId, input.caller);
    if (!after) throw new FormationAuthorityStoreError("selected-memory promotion barrier disappeared");
    if (after.phase === "source-published") {
      this.formationStore.advanceMutationBarrier({ operationId: input.operationId, caller: input.caller, expectedPhase: "source-published", phase: "authority-committed" });
      input.afterAuthorityCommitted?.();
    }
    this.formationStore.finishMutationBarrier({
      operationId: input.operationId,
      caller: input.caller,
      outcome: "committed",
      nextGenerationSha256: formationDigest(intent.nextVector.generation),
    });
    return structuredClone(intent.nextVector);
  }

  async recover(input: { agentId: string; caller: FormationCaller }): Promise<"none" | "rolled-back" | "completed"> {
    const barrier = this.formationStore.mutationBarrier(input.agentId, input.caller);
    if (!barrier) return "none";
    const intent = parseIntent(barrier);
    if (!this.memoryStore.verifyPromotionToken(intent.token)) throw new FormationAuthorityStoreError("selected-memory recovery authorization is invalid");
    const activeSha256 = selectedMemoryActiveDigest(await this.memoryStore.readActiveState(intent.agentName));
    const authority = this.formationStore.currentVector(intent.agentId);
    if (activeSha256 === intent.token.nextActiveSha256) {
      await this.commit({ operationId: barrier.operationId, caller: input.caller, agentId: input.agentId });
      return "completed";
    }
    if (barrier.phase === "prepared" && activeSha256 === intent.token.priorActiveSha256
      && authority && formationDigest(authority.generation) === intent.expectedGenerationSha256) {
      this.formationStore.finishMutationBarrier({ operationId: barrier.operationId, caller: input.caller, outcome: "rolled-back" });
      return "rolled-back";
    }
    throw new FormationAuthorityStoreError("selected-memory recovery found unrelated source or authority state");
  }
}
