import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidAgentName } from "../config/nameValidation.js";
import {
  SELECTED_MEMORY_MAX_ENTRY_BYTES,
  SELECTED_MEMORY_MAX_ENTRIES,
  SELECTED_MEMORY_MAX_TOTAL_BYTES,
  selectedMemoryActiveDigest,
  selectedMemoryCandidateBytes,
  selectedMemoryCandidateSchema,
  selectedMemoryManifestBytes,
  selectedMemoryManifestSchema,
  persistedSelectedMemoryManifestSchema,
  selectedMemorySha256,
  type SelectedMemoryActiveState,
  type SelectedMemoryCandidate,
  type SelectedMemoryEntry,
  type SelectedMemoryManifest,
} from "./domain.js";

const DIGEST_RE = /^[a-f0-9]{64}$/;

export class SelectedMemoryStoreError extends Error {
  constructor(message: string) { super(message); this.name = "SelectedMemoryStoreError"; }
}

export interface SelectedMemoryPromotionToken {
  schemaVersion: 1;
  agentName: string;
  agentId: string;
  candidateId: string;
  candidateSha256: string;
  candidate: SelectedMemoryCandidate;
  activationId: string;
  expectedVersion: number;
  approvedBy: string;
  approvedAt: string;
  priorActiveSha256: string;
  nextActiveSha256: string;
  nextActive: SelectedMemoryActiveState;
  authorization: string;
}

interface SelectedMemoryStoreOptions {
  now?: () => string;
  uuid?: () => string;
  authorityIntegrityKey: () => Buffer | undefined;
}

function assertAgentName(agentName: string): void {
  if (!isValidAgentName(agentName)) throw new SelectedMemoryStoreError("invalid selected-memory agent name");
}

function parseUtf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SelectedMemoryStoreError(`${label} is not valid UTF-8`); }
}

export class SelectedMemoryStore {
  private readonly now: () => string;
  private readonly uuid: () => string;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(private readonly workspaceRoot: string, private readonly options: SelectedMemoryStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  rootFor(agentName: string): string {
    assertAgentName(agentName);
    return path.join(this.workspaceRoot, ".tachyon", "agents", agentName, "memory");
  }
  manifestPath(agentName: string): string { return path.join(this.rootFor(agentName), "manifest.json"); }
  activeDir(agentName: string): string { return path.join(this.rootFor(agentName), "active"); }
  candidatesDir(agentName: string): string { return path.join(this.rootFor(agentName), "candidates"); }

  private async withMutation<T>(agentName: string, action: () => Promise<T>): Promise<T> {
    assertAgentName(agentName);
    const prior = this.mutationTails.get(agentName) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    this.mutationTails.set(agentName, tail);
    await prior;
    try { return await action(); }
    finally { release(); if (this.mutationTails.get(agentName) === tail) this.mutationTails.delete(agentName); }
  }

  private key(): Buffer {
    const key = this.options.authorityIntegrityKey();
    if (!key || key.length < 32) throw new SelectedMemoryStoreError("selected-memory promotion requires durable host authority custody");
    return key;
  }

  private authorize(payload: Omit<SelectedMemoryPromotionToken, "authorization">): string {
    return crypto.createHmac("sha256", this.key())
      .update("tachyon:selected-memory-promotion:v1\0").update(this.workspaceRoot).update("\0")
      .update(JSON.stringify(payload)).digest("hex");
  }

  verifyPromotionToken(token: SelectedMemoryPromotionToken): boolean {
    const { authorization, ...payload } = token;
    if (token.schemaVersion !== 1 || !selectedMemoryCandidateSchema.safeParse(token.candidate).success || !DIGEST_RE.test(token.candidateSha256)
      || !DIGEST_RE.test(token.priorActiveSha256) || !DIGEST_RE.test(token.nextActiveSha256)
      || selectedMemorySha256(selectedMemoryCandidateBytes(token.candidate)) !== token.candidateSha256
      || token.candidate.id !== token.candidateId || token.candidate.agentId !== token.agentId || token.candidate.agentName !== token.agentName
      || selectedMemoryActiveDigest(token.nextActive) !== token.nextActiveSha256) return false;
    let expected: string;
    try { expected = this.authorize(payload); } catch { return false; }
    const actual = DIGEST_RE.test(authorization) ? Buffer.from(authorization, "hex") : Buffer.alloc(0);
    const wanted = Buffer.from(expected, "hex");
    return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
  }

  private async openMemoryRoot(agentName: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
    if (process.platform !== "linux" || fsConstants.O_NOFOLLOW === undefined) throw new SelectedMemoryStoreError("selected-memory custody requires Linux O_NOFOLLOW");
    let directory = await fs.open(this.workspaceRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      for (const segment of [".tachyon", "agents", agentName, "memory"]) {
        const next = await fs.open(`/proc/self/fd/${directory.fd}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      return directory;
    } catch (error) { await directory.close(); throw error; }
  }

  private async initializeDirectories(agentName: string): Promise<void> {
    if (process.platform !== "linux" || fsConstants.O_NOFOLLOW === undefined) throw new SelectedMemoryStoreError("selected-memory custody requires Linux O_NOFOLLOW");
    let directory = await fs.open(this.workspaceRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      for (const segment of [".tachyon", "agents", agentName]) {
        const next = await fs.open(`/proc/self/fd/${directory.fd}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      await fs.mkdir(`/proc/self/fd/${directory.fd}/memory`, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const memory = await fs.open(`/proc/self/fd/${directory.fd}/memory`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try {
        for (const child of ["active", "candidates"]) {
          await fs.mkdir(`/proc/self/fd/${memory.fd}/${child}`, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          const verified = await fs.open(`/proc/self/fd/${memory.fd}/${child}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
          await verified.close();
        }
      } finally { await memory.close(); }
    } finally { await directory.close(); }
  }

  private async atomicWriteAnchored(agentName: string, segments: string[], bytes: Buffer | string): Promise<void> {
    let directory = await this.openMemoryRoot(agentName);
    try {
      for (const segment of segments.slice(0, -1)) {
        const next = await fs.open(`/proc/self/fd/${directory.fd}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      const leaf = segments.at(-1);
      if (!leaf || !/^[A-Za-z0-9._-]+$/.test(leaf)) throw new SelectedMemoryStoreError("selected-memory write path is unsafe");
      const target = `/proc/self/fd/${directory.fd}/${leaf}`;
      const temporary = `/proc/self/fd/${directory.fd}/.${leaf}.tmp-${process.pid}-${this.uuid()}`;
      const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, target);
      await directory.sync();
    } finally { await directory.close(); }
  }

  async initialize(agentName: string, agentId: string, activationId: string): Promise<SelectedMemoryManifest> {
    return this.withMutation(agentName, async () => {
      try { return (await this.readActiveState(agentName)).manifest; }
      catch (error) {
        if (!(error instanceof SelectedMemoryStoreError) || !error.message.includes("missing")) throw error;
      }
      const manifest = selectedMemoryManifestSchema.parse({
        schemaVersion: 1, activationId, agentId, agentName, version: 0, entries: [], updatedAt: this.now(),
      });
      await this.initializeDirectories(agentName);
      await this.atomicWriteAnchored(agentName, ["manifest.json"], selectedMemoryManifestBytes(manifest));
      return manifest;
    });
  }

  async createCandidate(agentName: string, input: {
    agentId: string;
    content: string;
    reason: string;
    sourcePrincipal: string;
    sourceKind: "human" | "agent" | "system";
  }): Promise<SelectedMemoryCandidate> {
    return this.withMutation(agentName, async () => {
      const active = await this.readActiveState(agentName);
      if (active.manifest.agentId !== input.agentId) throw new SelectedMemoryStoreError("selected-memory candidate belongs to another agentId");
      const candidate = selectedMemoryCandidateSchema.parse({
        schemaVersion: 1,
        id: `candidate-${this.uuid()}`,
        agentId: input.agentId,
        agentName,
        content: input.content,
        reason: input.reason,
        sourcePrincipal: input.sourcePrincipal,
        sourceKind: input.sourceKind,
        status: "pending",
        createdAt: this.now(),
      });
      await this.atomicWriteAnchored(agentName, ["candidates", `${candidate.id}.json`], selectedMemoryCandidateBytes(candidate));
      return candidate;
    });
  }

  private async readCandidate(agentName: string, candidateId: string): Promise<SelectedMemoryCandidate> {
    if (!/^candidate-[0-9a-f-]{36}$/.test(candidateId)) throw new SelectedMemoryStoreError("invalid selected-memory candidate id");
    const bytes = await this.readAnchoredFile(agentName, ["candidates", `${candidateId}.json`], 128 * 1024, "selected-memory candidate");
    try {
      const candidate = selectedMemoryCandidateSchema.parse(JSON.parse(parseUtf8(bytes, "selected-memory candidate")));
      if (candidate.id !== candidateId || candidate.agentName !== agentName) throw new SelectedMemoryStoreError("selected-memory candidate identity does not match its path");
      return candidate;
    }
    catch (error) { if (error instanceof SelectedMemoryStoreError) throw error; throw new SelectedMemoryStoreError("selected-memory candidate is malformed"); }
  }

  async preparePromotion(agentName: string, candidateId: string, input: {
    expectedVersion: number;
    expectedCandidateSha256: string;
    approvedBy: string;
  }): Promise<SelectedMemoryPromotionToken> {
    return this.withMutation(agentName, async () => {
      const prior = await this.readActiveState(agentName);
      const candidate = await this.readCandidate(agentName, candidateId);
      if (candidate.status !== "pending" || prior.manifest.version !== input.expectedVersion
        || candidate.agentId !== prior.manifest.agentId || candidate.agentName !== agentName
        || selectedMemorySha256(selectedMemoryCandidateBytes(candidate)) !== input.expectedCandidateSha256) {
        throw new SelectedMemoryStoreError("selected-memory candidate or active version changed before promotion");
      }
      if (prior.manifest.entries.length >= SELECTED_MEMORY_MAX_ENTRIES) throw new SelectedMemoryStoreError("selected-memory entry bound is exhausted");
      const approvedAt = this.now();
      const id = `memory-${this.uuid()}`;
      const contentBytes = Buffer.from(candidate.content, "utf8");
      const entry: SelectedMemoryEntry = {
        id,
        path: `active/${id}.md`,
        sha256: selectedMemorySha256(contentBytes),
        bytes: contentBytes.length,
        sourceCandidateId: candidate.id,
        sourcePrincipal: candidate.sourcePrincipal,
        sourceKind: candidate.sourceKind,
        approvedBy: input.approvedBy,
        approvedAt,
      };
      const entries = [...prior.manifest.entries, entry].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const nextManifest = selectedMemoryManifestSchema.parse({
        ...prior.manifest, version: prior.manifest.version + 1, entries, updatedAt: approvedAt,
      });
      const nextActive: SelectedMemoryActiveState = {
        manifest: nextManifest,
        contents: [...prior.contents, { path: entry.path, content: candidate.content }]
          .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      };
      const payload: Omit<SelectedMemoryPromotionToken, "authorization"> = {
        schemaVersion: 1, agentName, agentId: candidate.agentId, candidateId: candidate.id,
        candidateSha256: input.expectedCandidateSha256, candidate: structuredClone(candidate),
        activationId: prior.manifest.activationId, expectedVersion: input.expectedVersion,
        approvedBy: input.approvedBy, approvedAt,
        priorActiveSha256: selectedMemoryActiveDigest(prior),
        nextActiveSha256: selectedMemoryActiveDigest(nextActive),
        nextActive,
      };
      return { ...payload, authorization: this.authorize(payload) };
    });
  }

  async publishPreparedPromotion(token: SelectedMemoryPromotionToken): Promise<void> {
    if (!this.verifyPromotionToken(token)) throw new SelectedMemoryStoreError("selected-memory promotion token is invalid");
    await this.withMutation(token.agentName, async () => {
      const current = await this.readActiveState(token.agentName);
      const currentDigest = selectedMemoryActiveDigest(current);
      if (currentDigest === token.nextActiveSha256) {
        await this.finalizeCandidate(token);
        return;
      }
      if (currentDigest !== token.priorActiveSha256) throw new SelectedMemoryStoreError("selected-memory active state changed after preparation");
      const candidateBefore = await this.readCandidate(token.agentName, token.candidateId);
      if (candidateBefore.status !== "pending" || selectedMemorySha256(selectedMemoryCandidateBytes(candidateBefore)) !== token.candidateSha256) {
        throw new SelectedMemoryStoreError("selected-memory reviewed candidate changed before publication");
      }
      const priorPaths = new Set(current.contents.map((entry) => entry.path));
      for (const content of token.nextActive.contents) {
        if (priorPaths.has(content.path)) continue;
        await this.atomicWriteAnchored(token.agentName, content.path.split("/"), content.content);
      }
      await this.atomicWriteAnchored(token.agentName, ["manifest.json"], selectedMemoryManifestBytes(token.nextActive.manifest));
      await this.finalizeCandidate(token);
      if (selectedMemoryActiveDigest(await this.readActiveState(token.agentName)) !== token.nextActiveSha256) {
        throw new SelectedMemoryStoreError("selected-memory publication did not produce the authorized inventory");
      }
    });
  }

  private async finalizeCandidate(token: SelectedMemoryPromotionToken): Promise<void> {
    const candidate = await this.readCandidate(token.agentName, token.candidateId);
    const expected = selectedMemoryCandidateSchema.parse({
      ...token.candidate, status: "approved", resolvedAt: token.approvedAt, promotedVersion: token.nextActive.manifest.version,
    });
    if (candidate.status === "approved") {
      if (selectedMemoryCandidateBytes(candidate).equals(selectedMemoryCandidateBytes(expected))) return;
      throw new SelectedMemoryStoreError("selected-memory terminal candidate does not match its authorized promotion");
    }
    if (candidate.status !== "pending" || selectedMemorySha256(selectedMemoryCandidateBytes(candidate)) !== token.candidateSha256) {
      throw new SelectedMemoryStoreError("selected-memory candidate changed before terminal publication");
    }
    await this.atomicWriteAnchored(token.agentName, ["candidates", `${candidate.id}.json`], selectedMemoryCandidateBytes(expected));
  }

  async readActiveState(agentName: string): Promise<SelectedMemoryActiveState> {
    assertAgentName(agentName);
    let manifestBytes: Buffer;
    try { manifestBytes = await this.readAnchoredFile(agentName, ["manifest.json"], 256 * 1024, "selected-memory manifest"); }
    catch (error) { throw new SelectedMemoryStoreError(`selected-memory manifest is missing or unsafe: ${error instanceof Error ? error.message : String(error)}`); }
    let manifest: SelectedMemoryManifest;
    try { manifest = persistedSelectedMemoryManifestSchema.parse(JSON.parse(parseUtf8(manifestBytes, "selected-memory manifest"))); }
    catch { throw new SelectedMemoryStoreError("selected-memory manifest is malformed"); }
    if (manifest.agentName !== agentName) throw new SelectedMemoryStoreError("selected-memory manifest belongs to another agent");
    const contents: SelectedMemoryActiveState["contents"] = [];
    let total = 0;
    for (const entry of manifest.entries) {
      const bytes = await this.readAnchoredFile(agentName, entry.path.split("/"), SELECTED_MEMORY_MAX_ENTRY_BYTES, `selected-memory entry '${entry.path}'`);
      total += bytes.length;
      if (bytes.length !== entry.bytes || selectedMemorySha256(bytes) !== entry.sha256 || total > SELECTED_MEMORY_MAX_TOTAL_BYTES) {
        throw new SelectedMemoryStoreError(`selected-memory entry '${entry.path}' does not match its manifest`);
      }
      contents.push({ path: entry.path, content: parseUtf8(bytes, `selected-memory entry '${entry.path}'`) });
    }
    const manifestAfter = await this.readAnchoredFile(agentName, ["manifest.json"], 256 * 1024, "selected-memory manifest");
    if (!manifestAfter.equals(manifestBytes)) throw new SelectedMemoryStoreError("selected-memory manifest changed during capture");
    return { manifest, contents };
  }

  private async readAnchoredFile(agentName: string, segments: string[], maxBytes: number, label: string): Promise<Buffer> {
    if (process.platform !== "linux" || fsConstants.O_NOFOLLOW === undefined) throw new SelectedMemoryStoreError(`${label} requires Linux no-follow custody`);
    let directory = await this.openMemoryRoot(agentName);
    try {
      for (const segment of segments.slice(0, -1)) {
        if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..") throw new SelectedMemoryStoreError(`${label} has an unsafe path`);
        const next = await fs.open(`/proc/self/fd/${directory.fd}/${segment}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
        await directory.close();
        directory = next;
      }
      const leaf = segments.at(-1);
      if (!leaf || !/^[A-Za-z0-9._-]+$/.test(leaf)) throw new SelectedMemoryStoreError(`${label} has an unsafe filename`);
      const file = await fs.open(`/proc/self/fd/${directory.fd}/${leaf}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size > BigInt(maxBytes)) throw new SelectedMemoryStoreError(`${label} is unsafe or too large`);
        const bytes = await file.readFile();
        const after = await file.stat({ bigint: true });
        if (bytes.length > maxBytes || before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new SelectedMemoryStoreError(`${label} changed during read`);
        }
        return bytes;
      } finally { await file.close(); }
    } finally { await directory.close(); }
  }
}
