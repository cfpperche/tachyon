import crypto from "node:crypto";
import { parseDocument } from "yaml";
import type { Role } from "../../roles/templates.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile } from "../../config/agentProfileReader.js";
import { agentProfileSchemaV1, type AgentProfileV1 } from "../../config/agentProfileSchema.js";
import { composeAgentPrompt } from "../promptLayers.js";
import { resolveSoul, type ResolvedSoul } from "../soul.js";
import { resolvePersistentInstructions, type ResolvedPersistentInstructions } from "../persistentInstructions.js";
import {
  formationDigest,
  type FormationAuthorityVector,
  type FormationLaneName,
  type FormationNativeSuppressionEvidenceV1,
} from "./domain.js";
import type { ResolvedFormationPayload } from "./authorityStore.js";

export const HUMAN_SOUL_RENDERER_CONTRACT = "tachyon-soul-prompt-v1";
export const HUMAN_INSTRUCTIONS_RENDERER_CONTRACT = "tachyon-persistent-instructions-v1";
export const HUMAN_REANCHOR_RENDERER_CONTRACT = "tachyon-formation-reanchor-v1";
export const HUMAN_SOUL_RENDERER_SHA256 = formationDigest({ contract: HUMAN_SOUL_RENDERER_CONTRACT, order: 1, framing: "promptLayers.identity" });
export const HUMAN_INSTRUCTIONS_RENDERER_SHA256 = formationDigest({ contract: HUMAN_INSTRUCTIONS_RENDERER_CONTRACT, order: 3, framing: "promptLayers.instructions" });
export const HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256 = formationDigest({
  soul: HUMAN_SOUL_RENDERER_SHA256,
  instructions: HUMAN_INSTRUCTIONS_RENDERER_SHA256,
  reanchor: formationDigest({ contract: HUMAN_REANCHOR_RENDERER_CONTRACT, framing: "fixed-v1" }),
});

export class HumanFormationLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanFormationLaneError";
  }
}

export type HumanLaneSuppressionReceipt = FormationNativeSuppressionEvidenceV1;

function suppressionPayload(receipt: Omit<HumanLaneSuppressionReceipt, "mac">): string {
  return JSON.stringify(receipt);
}

/** Host-custodied capability. The runtime adapter calls issueAfterSuppression only after it disabled native lane delivery. */
export class HumanLaneSuppressionAuthority {
  private readonly key: Buffer;
  constructor(key: Buffer, private readonly now: () => string = () => new Date().toISOString(), private readonly maxAgeMs = 5 * 60 * 1000) {
    if (key.length < 32) throw new HumanFormationLaneError("human-lane suppression key must contain at least 32 bytes");
    this.key = Buffer.from(key);
  }

  issueAfterSuppression(input: {
    operationId: string;
    vector: FormationAuthorityVector;
    runtimeAdapter: string;
    runtimeTrustClass: string;
    lanes: readonly FormationLaneName[];
    issuedAt: string;
  }): HumanLaneSuppressionReceipt {
    const lanes = [...input.lanes].sort();
    const expected = (["soul", "instructions", "evolution", "memory"] as const)
      .filter((lane) => input.vector.profile.lanes[lane].mode === "profile").sort();
    if (new Set(lanes).size !== lanes.length || formationDigest(lanes) !== formationDigest(expected)) {
      throw new HumanFormationLaneError("suppression receipt must cover every enabled human lane exactly once");
    }
    if (input.runtimeAdapter !== input.vector.profile.runtimeInspector.adapter) {
      throw new HumanFormationLaneError("suppression receipt runtime adapter does not match profile authority");
    }
    const payload: Omit<HumanLaneSuppressionReceipt, "mac"> = {
      schemaVersion: 1,
      operationId: input.operationId,
      sourceVectorSha256: formationDigest(input.vector),
      runtimeAdapter: input.runtimeAdapter,
      runtimeTrustClass: input.runtimeTrustClass,
      lanes,
      issuedAt: input.issuedAt,
    };
    return { ...payload, mac: crypto.createHmac("sha256", this.key).update(suppressionPayload(payload)).digest("hex") };
  }

  verify(
    receipt: HumanLaneSuppressionReceipt,
    vector: FormationAuthorityVector,
    runtimeTrustClass: string,
    operationId: string,
    verifiedAt = this.now(),
  ): boolean {
    const { mac, ...payload } = receipt;
    const expectedMac = crypto.createHmac("sha256", this.key).update(suppressionPayload(payload)).digest();
    const actualMac = /^[a-f0-9]{64}$/.test(mac) ? Buffer.from(mac, "hex") : Buffer.alloc(0);
    const enabled = (["soul", "instructions", "evolution", "memory"] as const)
      .filter((lane) => vector.profile.lanes[lane].mode === "profile").sort();
    const issuedAt = Date.parse(receipt.issuedAt);
    const now = Date.parse(verifiedAt);
    return actualMac.length === expectedMac.length && crypto.timingSafeEqual(actualMac, expectedMac)
      && receipt.operationId === operationId
      && Number.isFinite(issuedAt) && Number.isFinite(now) && issuedAt <= now && now - issuedAt <= this.maxAgeMs
      && receipt.sourceVectorSha256 === formationDigest(vector)
      && receipt.runtimeAdapter === vector.profile.runtimeInspector.adapter
      && receipt.runtimeTrustClass === runtimeTrustClass
      && new Set(receipt.lanes).size === receipt.lanes.length
      && formationDigest([...receipt.lanes].sort()) === formationDigest(enabled);
  }
}

export interface ResolvedHumanFormationPayload extends ResolvedFormationPayload {
  soul?: ResolvedSoul;
  instructions?: ResolvedPersistentInstructions;
  suppression: HumanLaneSuppressionReceipt;
}

function validateLaneRenderer(
  vector: FormationAuthorityVector,
  laneName: "soul" | "instructions",
  contract: string,
  rendererSha256: string,
): void {
  const lane = vector.profile.lanes[laneName];
  if (lane.mode !== "profile") return;
  if (lane.rendererContract !== contract || lane.rendererSha256 !== rendererSha256) {
    throw new HumanFormationLaneError(`${laneName} renderer does not match the active profile authority`);
  }
}

function rejectLegacyModes(vector: FormationAuthorityVector): void {
  for (const laneName of ["soul", "instructions", "evolution", "memory"] as FormationLaneName[]) {
    if (vector.profile.lanes[laneName].mode === "legacy") throw new HumanFormationLaneError("canonical human-lane resolution cannot consume legacy authority");
  }
}

export async function resolveHumanFormationPayload(input: {
  operationId: string;
  workspaceRoot: string;
  vector: FormationAuthorityVector;
  role?: Role;
  bridgeGuidance: boolean;
  projectGuidance?: string;
  taskBrief?: string;
  taskContractCompletion?: "deliverable" | "done_when";
  runtimeTrustClass: string;
  suppressionAuthority: HumanLaneSuppressionAuthority;
  suppressionReceipt: HumanLaneSuppressionReceipt;
  /** Complete renderer-set digest expected by the caller composing additional canonical lanes. */
  expectedRendererContractsSha256?: string;
}): Promise<ResolvedHumanFormationPayload> {
  const { vector } = input;
  if (vector.generation.retired) throw new HumanFormationLaneError("retired formation authority cannot be rendered");
  const expectedRendererContractsSha256 = input.expectedRendererContractsSha256 ?? HUMAN_FORMATION_RENDERER_CONTRACTS_SHA256;
  if (vector.generation.rendererContractsSha256 !== expectedRendererContractsSha256) {
    throw new HumanFormationLaneError("formation generation does not bind the human renderer contract set");
  }
  rejectLegacyModes(vector);
  validateLaneRenderer(vector, "soul", HUMAN_SOUL_RENDERER_CONTRACT, HUMAN_SOUL_RENDERER_SHA256);
  validateLaneRenderer(vector, "instructions", HUMAN_INSTRUCTIONS_RENDERER_CONTRACT, HUMAN_INSTRUCTIONS_RENDERER_SHA256);
  if (!input.suppressionAuthority.verify(input.suppressionReceipt, vector, input.runtimeTrustClass, input.operationId)) {
    throw new HumanFormationLaneError("human-lane native suppression receipt is invalid");
  }

  const canonical = readCanonicalAgentProfile(input.workspaceRoot, vector.profile.agentName);
  if (!canonical) throw new HumanFormationLaneError("canonical agent profile is missing");
  let profile: AgentProfileV1;
  try {
    const document = parseDocument(canonical.text, { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length > 0 || canonical.sha256 !== vector.profile.canonicalSha256) {
      throw new HumanFormationLaneError("canonical agent profile bytes do not match active profile authority");
    }
    profile = agentProfileSchemaV1.parse(document.toJS());
    if (profile.agentId !== vector.profile.agentId) throw new HumanFormationLaneError("canonical agent profile belongs to another agentId");
  } finally {
    closeCanonicalAgentProfile(canonical);
  }

  let soul: ResolvedSoul | undefined;
  const soulLane = vector.profile.lanes.soul;
  if (soulLane.mode === "profile") {
    if (soulLane.path !== "SOUL.md") throw new HumanFormationLaneError("Soul must use the conventional SOUL.md source");
    const reference = profile.references?.find((candidate) => candidate.id === soulLane.selectorId);
    if (!reference || reference.kind !== "soul" || reference.scope !== "profile"
      || reference.owner !== vector.profile.agentId || reference.path !== soulLane.path || reference.sha256 !== soulLane.sourceSha256) {
      throw new HumanFormationLaneError("Soul selector does not match canonical agent profile authority");
    }
    soul = await resolveSoul(input.workspaceRoot, vector.profile.agentName, vector.profile.agentId);
    if (soul.profileId !== soulLane.subjectId || soul.sha256 !== soulLane.sourceSha256) {
      throw new HumanFormationLaneError("Soul bytes or subordinate identity do not match active profile authority");
    }
  }

  let instructions: ResolvedPersistentInstructions | undefined;
  const instructionsLane = vector.profile.lanes.instructions;
  if (instructionsLane.mode === "profile") {
    instructions = resolvePersistentInstructions({
      workspaceRoot: input.workspaceRoot,
      agentName: vector.profile.agentName,
      agentId: vector.profile.agentId,
      referenceId: instructionsLane.selectorId,
      subjectId: instructionsLane.subjectId,
      expectedPath: instructionsLane.path,
      expectedProfileSha256: vector.profile.canonicalSha256,
      expectedSha256: instructionsLane.sourceSha256,
    });
  }

  const startup = composeAgentPrompt({
    soul,
    role: input.role,
    instructions: instructions?.body,
    bridgeGuidance: input.bridgeGuidance,
    taskBrief: input.taskBrief,
    taskContractCompletion: input.taskContractCompletion,
  }).body;
  const formationOnly = composeAgentPrompt({
    soul,
    role: input.role,
    instructions: instructions?.body,
    bridgeGuidance: input.bridgeGuidance,
  }).body;
  const startupPrompt = [input.projectGuidance, startup].filter((value): value is string => !!value?.trim()).join("\n\n");
  const reminderBody = [input.projectGuidance, formationOnly].filter((value): value is string => !!value?.trim()).join("\n\n");
  const reanchorReminder = [
    "── AGENT FORMATION REMINDER V1 ──",
    reminderBody,
    "── END AGENT FORMATION REMINDER V1 ──",
  ].join("\n");
  return {
    sourceVectorSha256: formationDigest(vector),
    rendererContractsSha256: expectedRendererContractsSha256,
    startupPrompt,
    reanchorReminder,
    suppression: structuredClone(input.suppressionReceipt),
    nativeSuppression: structuredClone(input.suppressionReceipt),
    ...(soul ? { soul } : {}),
    ...(instructions ? { instructions } : {}),
  };
}
