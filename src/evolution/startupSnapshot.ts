import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillFrontmatter } from "../plugins/skill.js";
import { EvolutionStore, type EvolutionActiveSnapshotBytes } from "./EvolutionStore.js";
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

async function visitMaterializedFiles(root: string, prefix = ""): Promise<Map<string, { content: string; executable: boolean }> | undefined> {
  const files = new Map<string, { content: string; executable: boolean }>();
  const visit = async (directory: string, relativeRoot: string): Promise<boolean> => {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!await visit(absolute, relative)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      const stat = await fs.stat(absolute);
      files.set(relative, { content: await fs.readFile(absolute, "utf8"), executable: (stat.mode & 0o111) !== 0 });
    }
    return true;
  };
  return await visit(root, prefix) ? files : undefined;
}

async function materializeCapturedSkills(
  store: EvolutionStore,
  active: EvolutionActiveSnapshotBytes,
): Promise<string> {
  const contentKey = sha256(JSON.stringify({
    profileId: active.profile.profileId,
    version: active.profile.activeVersion,
    skills: active.skills.map(({ name, files }) => ({ name, digest: digestEvolutionSkillFiles(files) })),
  }));
  const snapshotsRoot = store.sessionSnapshotRoot(active.profile.profileId);
  const target = path.join(snapshotsRoot, contentKey, "skills");
  const expected = new Map<string, { content: string; executable: boolean }>();
  for (const { name, files } of active.skills) {
    for (const file of files) expected.set(`${name}/${file.path}`, { content: file.content, executable: file.executable === true });
  }
  const existing = await visitMaterializedFiles(target);
  if (existing && existing.size === expected.size
    && [...expected].every(([name, value]) => {
      const observed = existing.get(name);
      return observed?.content === value.content && observed.executable === value.executable;
    })) return target;

  const stagingRoot = path.join(snapshotsRoot, `.staging-${crypto.randomUUID()}`);
  const staging = path.join(stagingRoot, "skills");
  const backup = path.join(snapshotsRoot, `.replaced-${crypto.randomUUID()}`);
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const [relative, file] of expected) {
      const destination = path.join(staging, ...relative.split("/"));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, file.content, { encoding: "utf8", mode: file.executable ? 0o500 : 0o400, flag: "wx" });
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let replaced = false;
    try {
      await fs.rename(target, backup);
      replaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(staging, target);
    } catch (error) {
      if (replaced) await fs.rename(backup, target).catch(() => undefined);
      throw error;
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return target;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
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
  const active = await store.readAuthorizedActiveState(agent);
  const profile = active.profile;
  const learningsPath = store.learningsPath(agent);
  const learningsBody = active.learnings;
  const materializedSkillsRoot = await materializeCapturedSkills(store, active);
  const skills: EvolutionStartupSkill[] = [];
  for (const { name, files } of active.skills) {
    const skillMd = files.find((file) => file.path === "SKILL.md")!;
    const parsed = parseSkillFrontmatter(skillMd.content);
    if (!parsed.frontmatter) throw new Error(`active evolution skill '${name}' has invalid SKILL.md`);
    skills.push({
      name,
      description: parsed.frontmatter.description,
      digest: digestEvolutionSkillFiles(files),
      bundlePath: path.join(materializedSkillsRoot, name),
      skillMdPath: path.join(materializedSkillsRoot, name, "SKILL.md"),
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
