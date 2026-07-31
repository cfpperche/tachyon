import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import {
  agentProfileSchemaV1,
  type AgentProfileV1,
} from "./agentProfileSchema.js";
import { closeCanonicalAgentProfile, readCanonicalAgentProfile, verifiedDescriptorPath } from "./agentProfileReader.js";

export interface OwnershipProfileMutation {
  ownerAgentName: string;
  priorText: string;
  targetText: string;
  priorSha256: string;
  targetSha256: string;
  priorProfile: AgentProfileV1;
  targetProfile: AgentProfileV1;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeNew(file: string, bytes: string): void {
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

/** Read an owner profile and build the exact target for a child rename or forget. */
export function ownershipProfileMutation(
  workspaceRoot: string,
  ownerAgentName: string,
  childAgentName: string,
  replacement: string | undefined,
): OwnershipProfileMutation {
  const source = readCanonicalAgentProfile(workspaceRoot, ownerAgentName);
  if (!source) throw new Error(`canonical profile for ownership owner '${ownerAgentName}' is missing`);
  try {
    const doc = parseDocument(source.text, { uniqueKeys: true });
    if (doc.errors.length > 0) throw new Error(`canonical ownership profile YAML is invalid: ${doc.errors[0]!.message}`);
    const parsed = agentProfileSchemaV1.safeParse(doc.toJS());
    if (!parsed.success) throw new Error(`canonical ownership profile schema is invalid: ${parsed.error.issues[0]!.message}`);
    const priorProfile = parsed.data;
    const names = priorProfile.ownership?.subagents ?? [];
    const matches = names.filter((name) => name === childAgentName).length;
    if (matches !== 1) {
      throw new Error(`ownership profile for '${ownerAgentName}' does not contain exactly one '${childAgentName}' entry`);
    }
    if (replacement !== undefined && names.some((name) => name === replacement)) {
      throw new Error(`ownership profile for '${ownerAgentName}' already contains '${replacement}'`);
    }
    const nextNames = replacement === undefined
      ? names.filter((name) => name !== childAgentName)
      : names.map((name) => name === childAgentName ? replacement : name);
    const targetProfile = agentProfileSchemaV1.parse({
      ...priorProfile,
      ...(nextNames.length > 0 ? { ownership: { subagents: nextNames } } : { ownership: undefined }),
    });
    const targetText = stringify(targetProfile);
    return {
      ownerAgentName,
      priorText: source.text,
      targetText,
      priorSha256: source.sha256,
      targetSha256: digest(targetText),
      priorProfile,
      targetProfile,
    };
  } finally {
    closeCanonicalAgentProfile(source);
  }
}

export function canonicalProfileDigest(workspaceRoot: string, agentName: string): string | undefined {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) return undefined;
  try { return source.sha256; }
  finally { closeCanonicalAgentProfile(source); }
}

/** Replace one canonical profile with a digest-guarded, descriptor-relative write. */
export function replaceCanonicalProfileExact(
  workspaceRoot: string,
  agentName: string,
  expectedSha256: string,
  text: string,
): void {
  const source = readCanonicalAgentProfile(workspaceRoot, agentName);
  if (!source) throw new Error(`canonical profile for '${agentName}' is missing`);
  try {
    if (source.sha256 !== expectedSha256) throw new Error(`canonical profile for '${agentName}' changed (CAS mismatch)`);
    const root = verifiedDescriptorPath(source.profileDirectoryFd, source.source);
    const file = path.join(root, "agent.yml");
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      writeNew(temporary, text);
      fs.renameSync(temporary, file);
      syncDirectory(root);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
    }
  } finally {
    closeCanonicalAgentProfile(source);
  }
}
