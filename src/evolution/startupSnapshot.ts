import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillFrontmatter } from "../plugins/skill.js";
import { EvolutionStore } from "./EvolutionStore.js";
import { digestEvolutionSkillFiles } from "./skillBundle.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface EvolutionStartupSkill {
  name: string;
  description: string;
  digest: string;
  bundlePath: string;
  skillMdPath: string;
}

export interface EvolutionStartupSnapshot {
  schemaVersion: 1;
  profileId: string;
  agent: string;
  version: number;
  digest: string;
  learnings: {
    path: string;
    digest: string;
    body: string;
  };
  skills: EvolutionStartupSkill[];
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function compareSkill(a: EvolutionStartupSkill, b: EvolutionStartupSkill): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function snapshotDigest(input: Omit<EvolutionStartupSnapshot, "digest">): string {
  return sha256(JSON.stringify({
    schemaVersion: input.schemaVersion,
    profileId: input.profileId,
    agent: input.agent,
    version: input.version,
    learnings: { path: input.learnings.path, digest: input.learnings.digest },
    skills: input.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      digest: skill.digest,
      bundlePath: skill.bundlePath,
      skillMdPath: skill.skillMdPath,
    })),
  }));
}

function freezeSnapshot(snapshot: EvolutionStartupSnapshot): EvolutionStartupSnapshot {
  Object.freeze(snapshot.learnings);
  for (const skill of snapshot.skills) Object.freeze(skill);
  Object.freeze(snapshot.skills);
  return Object.freeze(snapshot);
}

export function isEvolutionStartupSnapshot(value: unknown): value is EvolutionStartupSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<EvolutionStartupSnapshot>;
  if (snapshot.schemaVersion !== 1 || typeof snapshot.profileId !== "string" || snapshot.profileId.length === 0
    || typeof snapshot.agent !== "string" || snapshot.agent.length === 0
    || !Number.isSafeInteger(snapshot.version) || (snapshot.version ?? -1) < 0
    || typeof snapshot.digest !== "string" || !SHA256_RE.test(snapshot.digest)
    || !snapshot.learnings || typeof snapshot.learnings.path !== "string" || !path.isAbsolute(snapshot.learnings.path)
    || typeof snapshot.learnings.digest !== "string" || !SHA256_RE.test(snapshot.learnings.digest)
    || typeof snapshot.learnings.body !== "string" || Buffer.byteLength(snapshot.learnings.body, "utf8") > 256 * 1024
    || !Array.isArray(snapshot.skills) || snapshot.skills.length > 128) return false;
  if (sha256(snapshot.learnings.body) !== snapshot.learnings.digest) return false;
  const names = new Set<string>();
  for (const skill of snapshot.skills) {
    if (!skill || typeof skill !== "object" || typeof skill.name !== "string" || names.has(skill.name)
      || typeof skill.description !== "string" || typeof skill.digest !== "string" || !SHA256_RE.test(skill.digest)
      || typeof skill.bundlePath !== "string" || !path.isAbsolute(skill.bundlePath)
      || typeof skill.skillMdPath !== "string" || !path.isAbsolute(skill.skillMdPath)) return false;
    names.add(skill.name);
  }
  return snapshotDigest(snapshot as EvolutionStartupSnapshot) === snapshot.digest;
}

export function immutableEvolutionStartupSnapshot(snapshot: EvolutionStartupSnapshot): EvolutionStartupSnapshot {
  if (!isEvolutionStartupSnapshot(snapshot)) throw new Error("invalid Agent Evolution startup snapshot");
  return freezeSnapshot(structuredClone(snapshot));
}

/** Resolve and freeze exactly one active Tachyon-owned snapshot for a fresh session. */
export async function resolveEvolutionStartupSnapshot(
  workspaceRoot: string,
  agent: string,
  store = new EvolutionStore(workspaceRoot),
): Promise<EvolutionStartupSnapshot> {
  const profile = await store.ensureProfile(agent);
  const learningsPath = store.learningsPath(agent);
  const learningsBody = await fs.readFile(learningsPath, "utf8");
  await store.readLearnings(agent);
  const skills: EvolutionStartupSkill[] = [];
  for (const name of await store.listSkillNames(agent)) {
    const files = await store.readSkillFiles(agent, name);
    if (!files) continue;
    const skillMd = files.find((file) => file.path === "SKILL.md")!;
    const parsed = parseSkillFrontmatter(skillMd.content);
    if (!parsed.frontmatter) throw new Error(`active evolution skill '${name}' has invalid SKILL.md`);
    skills.push({
      name,
      description: parsed.frontmatter.description,
      digest: digestEvolutionSkillFiles(files),
      bundlePath: store.skillDir(agent, name),
      skillMdPath: path.join(store.skillDir(agent, name), "SKILL.md"),
    });
  }
  skills.sort(compareSkill);
  const withoutDigest: Omit<EvolutionStartupSnapshot, "digest"> = {
    schemaVersion: 1,
    profileId: profile.profileId,
    agent,
    version: profile.activeVersion,
    learnings: {
      path: learningsPath,
      digest: sha256(learningsBody),
      body: learningsBody,
    },
    skills,
  };
  return immutableEvolutionStartupSnapshot({ ...withoutDigest, digest: snapshotDigest(withoutDigest) });
}

export function renderEvolutionPromptLayer(snapshot: EvolutionStartupSnapshot): string {
  const skills = snapshot.skills.length === 0
    ? "No human-approved Agent Skills are active in this session."
    : snapshot.skills.map((skill) => [
        `- ${skill.name}: ${skill.description}`,
        `  SKILL.md: ${skill.skillMdPath}`,
        `  Digest: ${skill.digest}`,
      ].join("\n")).join("\n");
  return [
    "## Agent Evolution (human-approved session snapshot)",
    `Profile: ${snapshot.agent} v${snapshot.version} (${snapshot.digest})`,
    "This learned context and skill catalog are fixed for this session. Read a relevant SKILL.md and use its scripts/tools through your existing runtime tools when useful.",
    snapshot.learnings.body.trim(),
    "### Agent Skills",
    skills,
  ].join("\n\n");
}
