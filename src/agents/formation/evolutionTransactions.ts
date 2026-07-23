import {
  EvolutionStore,
  evolutionActiveSnapshotDigest,
  type EvolutionFormationPromotionToken,
  type ResolveEvolutionCandidateInput,
} from "../../evolution/EvolutionStore.js";
import {
  FormationAuthorityStore,
  FormationAuthorityStoreError,
  type FormationCaller,
  type FormationMutationBarrier,
} from "./authorityStore.js";
import { formationDigest, validateFormationAuthorityVector, type FormationAuthorityVector } from "./domain.js";
import { evolutionActivationHeadForState } from "./evolutionLane.js";

interface EvolutionPromotionIntent {
  schemaVersion: 1;
  kind: "evolution-formation-promotion";
  workspaceId: string;
  agentId: string;
  agentName: string;
  expectedGenerationSha256: string;
  token: EvolutionFormationPromotionToken;
  nextEvolutionHeadSha256: string;
  nextVector: FormationAuthorityVector;
}

function parseIntent(barrier: FormationMutationBarrier): EvolutionPromotionIntent {
  const intent = barrier.intent as Partial<EvolutionPromotionIntent> | undefined;
  if (!intent || intent.schemaVersion !== 1 || intent.kind !== "evolution-formation-promotion"
    || typeof intent.workspaceId !== "string" || typeof intent.agentId !== "string" || typeof intent.agentName !== "string"
    || typeof intent.expectedGenerationSha256 !== "string" || typeof intent.nextEvolutionHeadSha256 !== "string"
    || !intent.token || !intent.nextVector) {
    throw new FormationAuthorityStoreError("Evolution promotion intent is corrupt");
  }
  const errors = validateFormationAuthorityVector(intent.nextVector);
  if (errors.length > 0 || barrier.mutation !== "evolution-promotion" || barrier.workspaceId !== intent.workspaceId
    || barrier.agentId !== intent.agentId || barrier.expectedGenerationSha256 !== intent.expectedGenerationSha256
    || intent.nextVector.profile.workspaceId !== intent.workspaceId || intent.nextVector.profile.agentId !== intent.agentId
    || intent.nextVector.profile.agentName !== intent.agentName || intent.token.agent !== intent.agentName
    || !intent.nextVector.evolution || formationDigest(intent.nextVector.evolution) !== intent.nextEvolutionHeadSha256) {
    throw new FormationAuthorityStoreError("Evolution promotion intent does not match its authority barrier");
  }
  return intent as EvolutionPromotionIntent;
}

/** Couples the store-authenticated result of one human-reviewed candidate to a new formation generation. */
export class EvolutionFormationTransactionService {
  constructor(
    private readonly formationStore: FormationAuthorityStore,
    private readonly evolutionStore: EvolutionStore,
  ) {}

  async preparePromotion(input: {
    operationId: string;
    caller: FormationCaller;
    workspaceId: string;
    agentId: string;
    agentName: string;
    candidateId: string;
    expectedGenerationSha256: string;
    candidate: ResolveEvolutionCandidateInput;
  }): Promise<FormationMutationBarrier> {
    if (input.caller.kind !== "human") throw new FormationAuthorityStoreError("Evolution promotion requires a human caller");
    const current = this.formationStore.currentVector(input.agentId);
    if (!current || !current.evolution || formationDigest(current.generation) !== input.expectedGenerationSha256
      || current.profile.workspaceId !== input.workspaceId || current.profile.agentId !== input.agentId
      || current.profile.agentName !== input.agentName || current.generation.retired) {
      throw new FormationAuthorityStoreError("Evolution promotion does not match active formation authority");
    }
    const token = await this.evolutionStore.prepareFormationPromotion(input.agentName, input.candidateId, input.candidate);
    if (!this.evolutionStore.verifyFormationPromotionToken(token)) {
      throw new FormationAuthorityStoreError("Evolution store returned an invalid promotion authorization");
    }
    const active = await this.evolutionStore.readAuthorizedActiveState(input.agentName);
    if (evolutionActiveSnapshotDigest(active) !== token.priorActiveSha256) {
      throw new FormationAuthorityStoreError("Evolution active source changed before promotion preparation");
    }
    const nextHead = evolutionActivationHeadForState({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      revision: current.evolution.revision + 1,
      priorRevision: current.evolution.revision,
      active: token.nextActive,
    });
    const nextVector: FormationAuthorityVector = {
      profile: structuredClone(current.profile),
      ...(current.memory ? { memory: structuredClone(current.memory) } : {}),
      evolution: nextHead,
      generation: {
        ...structuredClone(current.generation),
        generation: current.generation.generation + 1,
        priorGeneration: current.generation.generation,
        evolution: { revision: nextHead.revision, digest: formationDigest(nextHead) },
      },
    };
    const intent: EvolutionPromotionIntent = {
      schemaVersion: 1,
      kind: "evolution-formation-promotion",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentName: input.agentName,
      expectedGenerationSha256: input.expectedGenerationSha256,
      token,
      nextEvolutionHeadSha256: formationDigest(nextHead),
      nextVector,
    };
    return this.formationStore.beginMutationBarrier({
      operationId: input.operationId,
      mutation: "evolution-promotion",
      caller: input.caller,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      expectedGenerationSha256: input.expectedGenerationSha256,
      intent,
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
        throw new FormationAuthorityStoreError("Evolution promotion is terminal with another outcome");
      }
      return current;
    }
    const barrier = this.formationStore.mutationBarrier(input.agentId, input.caller);
    if (!barrier || barrier.operationId !== input.operationId) throw new FormationAuthorityStoreError("Evolution promotion barrier is unavailable");
    const intent = parseIntent(barrier);
    if (!this.evolutionStore.verifyFormationPromotionToken(intent.token)) {
      throw new FormationAuthorityStoreError("Evolution promotion authorization is invalid");
    }
    if (barrier.phase === "prepared") {
      const before = await this.evolutionStore.readAuthorizedActiveState(intent.agentName);
      const beforeSha256 = evolutionActiveSnapshotDigest(before);
      if (beforeSha256 === intent.token.priorActiveSha256) {
        await this.evolutionStore.approvePreparedFormationPromotion(intent.token);
      } else if (beforeSha256 !== intent.token.nextActiveSha256) {
        throw new FormationAuthorityStoreError("Evolution active source changed before publication");
      }
      const after = await this.evolutionStore.readAuthorizedActiveState(intent.agentName);
      if (evolutionActiveSnapshotDigest(after) !== intent.token.nextActiveSha256) {
        throw new FormationAuthorityStoreError("Evolution source promotion did not publish the authorized active inventory");
      }
      this.formationStore.advanceMutationBarrier({
        operationId: input.operationId,
        caller: input.caller,
        expectedPhase: "prepared",
        phase: "source-published",
      });
      input.afterSourcePublished?.();
    }
    const active = await this.evolutionStore.readAuthorizedActiveState(intent.agentName);
    if (evolutionActiveSnapshotDigest(active) !== intent.token.nextActiveSha256) {
      throw new FormationAuthorityStoreError("Evolution active inventory changed before authority commit");
    }
    const current = this.formationStore.currentVector(intent.agentId);
    if (!current || formationDigest(current.generation) !== formationDigest(intent.nextVector.generation)) {
      this.formationStore.replaceVector({
        operationId: input.operationId,
        caller: input.caller,
        mutation: "evolution-promotion",
        vector: intent.nextVector,
        expectedGenerationSha256: intent.expectedGenerationSha256,
      });
    }
    const after = this.formationStore.mutationBarrier(input.agentId, input.caller);
    if (!after) throw new FormationAuthorityStoreError("Evolution promotion barrier disappeared before commit");
    if (after.phase === "source-published") {
      this.formationStore.advanceMutationBarrier({
        operationId: input.operationId,
        caller: input.caller,
        expectedPhase: "source-published",
        phase: "authority-committed",
      });
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

  async recover(input: {
    agentId: string;
    caller: FormationCaller;
  }): Promise<"none" | "rolled-back" | "completed"> {
    const barrier = this.formationStore.mutationBarrier(input.agentId, input.caller);
    if (!barrier) return "none";
    const intent = parseIntent(barrier);
    if (!this.evolutionStore.verifyFormationPromotionToken(intent.token)) {
      throw new FormationAuthorityStoreError("Evolution promotion recovery authorization is invalid");
    }
    const active = await this.evolutionStore.readAuthorizedActiveState(intent.agentName);
    const activeSha256 = evolutionActiveSnapshotDigest(active);
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
    throw new FormationAuthorityStoreError("Evolution promotion recovery found unrelated source or authority state");
  }
}
