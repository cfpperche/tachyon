import crypto from "node:crypto";
import { parseDocument } from "yaml";
import { parseSkillFrontmatter } from "../../plugins/skill.js";
import {
  closeCanonicalAgentProfile,
  readAgentProfileReference,
  readCanonicalAgentProfile,
} from "../../config/agentProfileReader.js";
import { agentProfileSchemaV1 } from "../../config/agentProfileSchema.js";
import { EvolutionStore, type EvolutionActiveSnapshotBytes } from "../../evolution/EvolutionStore.js";
import { digestEvolutionSkillFiles } from "../../evolution/skillBundle.js";
import {
  formationDigest,
  formationSkillInventoryDigest,
  formationSkillRelativePathError,
  type EvolutionActivationHeadV2,
  type FormationAuthorityVector,
  type FormationObject,
} from "./domain.js";
import type { FormationSkillPayload, ResolvedFormationPayload } from "./authorityStore.js";

export const EVOLUTION_FORMATION_RENDERER_CONTRACT = "tachyon-evolution-formation-v1";
export const EVOLUTION_FORMATION_RENDERER_SHA256 = formationDigest({
  contract: EVOLUTION_FORMATION_RENDERER_CONTRACT,
  framing: "learned-context-and-complete-skill-inventory",
});
export const EVOLUTION_FORMATION_MAX_LEARNINGS_BYTES = 256 * 1024;
export const EVOLUTION_FORMATION_MAX_SKILLS = 128;
export const EVOLUTION_FORMATION_MAX_FILES = 1024;
export const EVOLUTION_FORMATION_MAX_FILE_BYTES = 1024 * 1024;
export const EVOLUTION_FORMATION_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export class EvolutionFormationLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionFormationLaneError";
  }
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalEvolutionProfileBytes(profile: EvolutionActiveSnapshotBytes["profile"]): Buffer {
  return Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

function inventory(active: EvolutionActiveSnapshotBytes): {
  skills: FormationSkillPayload[];
  entries: EvolutionActivationHeadV2["skillInventory"];
  digest: string;
} {
  if (Buffer.byteLength(active.learnings, "utf8") > EVOLUTION_FORMATION_MAX_LEARNINGS_BYTES) {
    throw new EvolutionFormationLaneError("active Evolution learnings exceed the formation bound");
  }
  if (active.skills.length > EVOLUTION_FORMATION_MAX_SKILLS) {
    throw new EvolutionFormationLaneError("active Evolution skill count exceeds the formation bound");
  }
  const names = new Set<string>();
  const skills: FormationSkillPayload[] = [];
  let files = 0;
  let totalBytes = Buffer.byteLength(active.learnings, "utf8");
  for (const skill of [...active.skills].sort((a, b) => compareText(a.name, b.name))) {
    if (names.has(skill.name)) throw new EvolutionFormationLaneError("active Evolution inventory contains a duplicate skill");
    names.add(skill.name);
    if (digestEvolutionSkillFiles(skill.files).length !== 64) throw new EvolutionFormationLaneError("active Evolution skill digest is invalid");
    for (const file of skill.files) {
      files += 1;
      const bytes = Buffer.from(file.content, "utf8");
      totalBytes += bytes.length;
      const relative = `evolution/${skill.name}/${file.path}`;
      if (formationSkillRelativePathError(relative)) throw new EvolutionFormationLaneError(`unsafe active Evolution path '${relative}'`);
      if (bytes.length > EVOLUTION_FORMATION_MAX_FILE_BYTES || files > EVOLUTION_FORMATION_MAX_FILES
        || totalBytes > EVOLUTION_FORMATION_MAX_TOTAL_BYTES) {
        throw new EvolutionFormationLaneError("active Evolution inventory exceeds the formation bounds");
      }
      skills.push({ path: relative, bytes, executable: file.executable === true });
    }
  }
  skills.sort((a, b) => compareText(a.path, b.path));
  const objects: FormationObject[] = skills.map((skill) => ({
    kind: "evolution-skill",
    path: skill.path,
    sha256: sha256(skill.bytes),
    bytes: Buffer.isBuffer(skill.bytes) ? skill.bytes.length : Buffer.byteLength(skill.bytes),
    executable: skill.executable === true,
  }));
  return {
    skills,
    entries: objects.map((object) => ({
      path: object.path!,
      sha256: object.sha256,
      bytes: object.bytes,
      executable: object.executable === true,
    })),
    digest: formationSkillInventoryDigest(objects),
  };
}

export function evolutionActivationHeadForState(input: {
  workspaceId: string;
  agentId: string;
  revision: number;
  priorRevision: number;
  active: EvolutionActiveSnapshotBytes;
}): EvolutionActivationHeadV2 {
  const captured = inventory(input.active);
  return {
    schemaVersion: 2,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    profileId: input.active.profile.profileId,
    revision: input.revision,
    priorRevision: input.priorRevision,
    activeVersion: input.active.profile.activeVersion,
    profileManifestSha256: sha256(canonicalEvolutionProfileBytes(input.active.profile)),
    learningsSha256: sha256(input.active.learnings),
    skillsInventorySha256: captured.digest,
    skillInventory: captured.entries,
  };
}

function renderEvolution(active: EvolutionActiveSnapshotBytes, head: EvolutionActivationHeadV2): string {
  const catalog = active.skills.length === 0
    ? "No human-approved Agent Skills are active in this formation."
    : [...active.skills].sort((a, b) => compareText(a.name, b.name)).map((skill) => {
        const skillMd = skill.files.find((file) => file.path === "SKILL.md");
        const parsed = skillMd ? parseSkillFrontmatter(skillMd.content) : undefined;
        if (!parsed?.frontmatter) throw new EvolutionFormationLaneError(`active Evolution skill '${skill.name}' has invalid SKILL.md`);
        return `- ${skill.name}: ${parsed.frontmatter.description}\n  Snapshot: evolution/${skill.name}/SKILL.md`;
      }).join("\n");
  return [
    "## Agent Evolution (human-approved formation snapshot)",
    `Profile: ${head.profileId} v${head.activeVersion}`,
    "This learned context and skill catalog are immutable for this session.",
    active.learnings.trim(),
    "### Agent Skills",
    catalog,
  ].join("\n\n");
}

export async function resolveEvolutionFormationLane(input: {
  workspaceRoot: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  vector: FormationAuthorityVector;
  store?: EvolutionStore;
}): Promise<ResolvedFormationPayload & { active: EvolutionActiveSnapshotBytes }> {
  const lane = input.vector.profile.lanes.evolution;
  const head = input.vector.evolution;
  if (lane.mode !== "profile" || !head) throw new EvolutionFormationLaneError("Evolution formation lane is not active");
  if (input.vector.generation.retired || input.vector.profile.workspaceId !== input.workspaceId
    || input.vector.profile.agentId !== input.agentId || input.vector.profile.agentName !== input.agentName
    || head.workspaceId !== input.workspaceId || head.agentId !== input.agentId
    || lane.subjectId !== head.profileId || lane.path !== "evolution/profile.json"
    || lane.rendererContract !== EVOLUTION_FORMATION_RENDERER_CONTRACT
    || lane.rendererSha256 !== EVOLUTION_FORMATION_RENDERER_SHA256) {
    throw new EvolutionFormationLaneError("Evolution lane does not match active formation authority");
  }
  const profileSource = readCanonicalAgentProfile(input.workspaceRoot, input.agentName);
  if (!profileSource) throw new EvolutionFormationLaneError("canonical agent profile is missing");
  try {
    if (profileSource.sha256 !== input.vector.profile.canonicalSha256) {
      throw new EvolutionFormationLaneError("canonical agent profile digest does not match formation authority");
    }
    const document = parseDocument(profileSource.text, { prettyErrors: false, uniqueKeys: true });
    const parsed = agentProfileSchemaV1.safeParse(document.toJS());
    const reference = parsed.success
      ? parsed.data.references?.find((candidate) => candidate.id === lane.selectorId)
      : undefined;
    if (document.errors.length > 0 || !parsed.success || parsed.data.agentId !== input.agentId || !reference
      || reference.kind !== "evolution" || reference.scope !== "profile" || reference.owner !== input.agentId
      || reference.path !== lane.path || reference.sha256 !== lane.sourceSha256) {
      throw new EvolutionFormationLaneError("Evolution profile reference does not match canonical agent profile authority");
    }
    const manifest = readAgentProfileReference(profileSource, reference.path, head.profileManifestSha256);
    const store = input.store ?? new EvolutionStore(input.workspaceRoot);
    const active = await store.readAuthorizedActiveState(input.agentName);
    if (manifest.sha256 !== sha256(canonicalEvolutionProfileBytes(active.profile))
      || active.profile.profileId !== head.profileId || active.profile.activeVersion !== head.activeVersion) {
      throw new EvolutionFormationLaneError("Evolution profile projection does not match active authority head");
    }
    const captured = inventory(active);
    if (sha256(active.learnings) !== head.learningsSha256 || captured.digest !== head.skillsInventorySha256
      || formationDigest(captured.entries) !== formationDigest(head.skillInventory)) {
      throw new EvolutionFormationLaneError("Evolution active bytes do not match active authority head");
    }
    const prompt = renderEvolution(active, head);
    return {
      sourceVectorSha256: formationDigest(input.vector),
      rendererContractsSha256: input.vector.generation.rendererContractsSha256,
      startupPrompt: prompt,
      reanchorReminder: ["── AGENT EVOLUTION REMINDER V1 ──", prompt, "── END AGENT EVOLUTION REMINDER V1 ──"].join("\n"),
      evolutionLearnings: Buffer.from(active.learnings, "utf8"),
      evolutionSkills: captured.skills,
      active,
    };
  } finally {
    closeCanonicalAgentProfile(profileSource);
  }
}
