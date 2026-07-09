import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TASK_ID_RE } from "./types.js";
import { PROTOTYPE_HTML_POLICY_VERSION, validatePrototypeHtml } from "./prototypeHtmlPolicy.js";

export const TASK_PROTOTYPE_SCHEMA_VERSION = 1;
export const TASK_PROTOTYPE_TITLE_MAX = 200;
export const TASK_PROTOTYPE_REVIEW_MAX = 4000;
export type TaskPrototypeState = "draft" | "approved" | "superseded" | "rejected";

export interface TaskPrototypeReview {
  action: "note" | "approved" | "rejected";
  text?: string;
  at: string;
  by: "human";
  sha256: string;
}

export interface TaskPrototypeRevision {
  id: string;
  sha256: string;
  byteSize: number;
  decodedDataBytes: number;
  mediaType: "text/html";
  policyVersion: number;
  title: string;
  author: string;
  state: TaskPrototypeState;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: "human";
  supersededBy?: string;
  reviews: TaskPrototypeReview[];
  needsTaskReconciliation?: boolean;
}

export interface TaskPrototypeManifest {
  schemaVersion: typeof TASK_PROTOTYPE_SCHEMA_VERSION;
  taskId: string;
  updatedAt: string;
  prototypes: TaskPrototypeRevision[];
}

export interface ResolvedTaskPrototype extends TaskPrototypeRevision {
  available: boolean;
  integrity: "verified" | "missing" | "mismatch" | "policy-unknown";
  relativePath: string;
}

export interface TaskPrototypeSnapshot {
  taskId: string;
  updatedAt?: string;
  readOnly: boolean;
  error?: string;
  prototypes: ResolvedTaskPrototype[];
  approved?: ResolvedTaskPrototype;
}

export class TaskPrototypeStore {
  constructor(private readonly workspaceRoot: string, readonly taskId: string) {
    if (!TASK_ID_RE.test(taskId)) throw new Error(`invalid task id '${taskId}'`);
  }

  get attachmentDir(): string { return path.join(this.workspaceRoot, ".tachyon", "tasks", "attachments", this.taskId); }
  get prototypeDir(): string { return path.join(this.attachmentDir, "prototypes"); }
  get manifestPath(): string { return path.join(this.attachmentDir, "prototypes.json"); }

  prototypePath(sha256: string): string {
    assertSha(sha256);
    return path.join(this.prototypeDir, sha256, "prototype.html");
  }

  relativePrototypePath(sha256: string): string {
    assertSha(sha256);
    return `.tachyon/tasks/attachments/${this.taskId}/prototypes/${sha256}/prototype.html`;
  }

  createDraft(input: { html: string; title: string; author: string; mediaType?: string; now?: string }): TaskPrototypeSnapshot {
    const checked = validatePrototypeHtml(input.html, input.mediaType);
    const title = bounded(input.title, "prototype title", TASK_PROTOTYPE_TITLE_MAX);
    const author = bounded(input.author, "prototype author", 64);
    const current = this.readManifestOrEmpty();
    const now = input.now ?? new Date().toISOString();
    const sha256 = crypto.createHash("sha256").update(input.html, "utf8").digest("hex");
    const revision: TaskPrototypeRevision = {
      id: `p-${crypto.randomBytes(6).toString("hex")}`,
      sha256,
      byteSize: checked.byteSize,
      decodedDataBytes: checked.decodedDataBytes,
      mediaType: "text/html",
      policyVersion: checked.policyVersion,
      title,
      author,
      state: "draft",
      createdAt: now,
      reviews: [],
    };
    const blob = this.prototypePath(sha256);
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    if (!fs.existsSync(blob)) atomicWrite(blob, input.html);
    else if (fs.readFileSync(blob, "utf8") !== input.html) throw new Error("prototype content-addressed blob collision or corruption");
    try {
      this.writeManifest({ ...current, updatedAt: now, prototypes: [...current.prototypes, revision] });
    } catch (err) {
      // A content-addressed blob may be shared by an older revision. Remove only a newly-created unreferenced blob.
      if (!current.prototypes.some((p) => p.sha256 === sha256)) {
        try { fs.rmSync(path.dirname(blob), { recursive: true, force: true }); } catch { /* best effort */ }
      }
      throw err;
    }
    return this.read();
  }

  approve(id: string, input: { expectUpdatedAt: string; now?: string; review?: string }): TaskPrototypeSnapshot {
    return this.transition(id, "approved", input);
  }

  reject(id: string, input: { expectUpdatedAt: string; now?: string; review?: string }): TaskPrototypeSnapshot {
    return this.transition(id, "rejected", input);
  }

  addReview(id: string, input: { expectUpdatedAt: string; text: string; now?: string }): TaskPrototypeSnapshot {
    const manifest = this.readMutable(input.expectUpdatedAt);
    const target = manifest.prototypes.find((p) => p.id === id);
    if (!target) throw new Error(`unknown prototype '${id}'`);
    const now = input.now ?? new Date().toISOString();
    target.reviews.push({ action: "note", text: bounded(input.text, "prototype review", TASK_PROTOTYPE_REVIEW_MAX), at: now, by: "human", sha256: target.sha256 });
    manifest.updatedAt = now;
    this.writeManifest(manifest);
    return this.read();
  }

  markNeedsTaskReconciliation(id: string, expectUpdatedAt: string, value = true, now = new Date().toISOString()): TaskPrototypeSnapshot {
    const manifest = this.readMutable(expectUpdatedAt);
    const target = manifest.prototypes.find((p) => p.id === id && p.state === "approved");
    if (!target) throw new Error(`approved prototype '${id}' not found`);
    if (value) target.needsTaskReconciliation = true; else delete target.needsTaskReconciliation;
    manifest.updatedAt = now;
    this.writeManifest(manifest);
    return this.read();
  }

  readHtml(id: string): string {
    const snapshot = this.read();
    const revision = snapshot.prototypes.find((p) => p.id === id);
    if (!revision || !revision.available) throw new Error(`prototype '${id}' is unavailable`);
    return fs.readFileSync(this.prototypePath(revision.sha256), "utf8");
  }

  read(): TaskPrototypeSnapshot {
    if (!fs.existsSync(this.manifestPath)) return { taskId: this.taskId, readOnly: false, prototypes: [] };
    let manifest: TaskPrototypeManifest;
    try { manifest = parseManifest(JSON.parse(fs.readFileSync(this.manifestPath, "utf8")), this.taskId); }
    catch (err) { return { taskId: this.taskId, readOnly: true, error: err instanceof Error ? err.message : String(err), prototypes: [] }; }
    const prototypes = manifest.prototypes.map((revision) => this.resolve(revision));
    const approved = prototypes.find((p) => p.state === "approved");
    return {
      taskId: this.taskId,
      updatedAt: manifest.updatedAt,
      readOnly: prototypes.some((p) => !p.available),
      prototypes,
      ...(approved ? { approved } : {}),
    };
  }

  cleanup(): void {
    fs.rmSync(this.prototypeDir, { recursive: true, force: true });
    try { fs.unlinkSync(this.manifestPath); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }

  private transition(id: string, state: "approved" | "rejected", input: { expectUpdatedAt: string; now?: string; review?: string }): TaskPrototypeSnapshot {
    const manifest = this.readMutable(input.expectUpdatedAt);
    const target = manifest.prototypes.find((p) => p.id === id);
    if (!target) throw new Error(`unknown prototype '${id}'`);
    if (target.state !== "draft") throw new Error(`invalid prototype transition ${target.state} -> ${state}`);
    const now = input.now ?? new Date().toISOString();
    if (state === "approved") {
      for (const previous of manifest.prototypes) {
        if (previous.state === "approved") {
          previous.state = "superseded";
          previous.supersededBy = target.id;
        }
      }
      target.state = "approved";
      target.approvedAt = now;
      target.approvedBy = "human";
      target.reviews.push({ action: "approved", ...(input.review ? { text: bounded(input.review, "prototype review", TASK_PROTOTYPE_REVIEW_MAX) } : {}), at: now, by: "human", sha256: target.sha256 });
    } else {
      target.state = "rejected";
      target.reviews.push({ action: "rejected", ...(input.review ? { text: bounded(input.review, "prototype review", TASK_PROTOTYPE_REVIEW_MAX) } : {}), at: now, by: "human", sha256: target.sha256 });
    }
    manifest.updatedAt = now;
    this.writeManifest(manifest);
    return this.read();
  }

  private readManifestOrEmpty(): TaskPrototypeManifest {
    if (!fs.existsSync(this.manifestPath)) return { schemaVersion: 1, taskId: this.taskId, updatedAt: "", prototypes: [] };
    return parseManifest(JSON.parse(fs.readFileSync(this.manifestPath, "utf8")), this.taskId);
  }

  private readMutable(expectUpdatedAt: string): TaskPrototypeManifest {
    const manifest = this.readManifestOrEmpty();
    if (manifest.updatedAt !== expectUpdatedAt) throw new Error("precondition-failed: prototype manifest updatedAt did not match");
    return structuredClone(manifest);
  }

  private writeManifest(manifest: TaskPrototypeManifest): void {
    parseManifest(manifest, this.taskId);
    fs.mkdirSync(this.attachmentDir, { recursive: true });
    atomicWrite(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  private resolve(revision: TaskPrototypeRevision): ResolvedTaskPrototype {
    const relativePath = this.relativePrototypePath(revision.sha256);
    if (revision.policyVersion !== PROTOTYPE_HTML_POLICY_VERSION) return { ...revision, available: false, integrity: "policy-unknown", relativePath };
    let bytes: Buffer;
    try { bytes = fs.readFileSync(this.prototypePath(revision.sha256)); }
    catch { return { ...revision, available: false, integrity: "missing", relativePath }; }
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (actual !== revision.sha256 || bytes.byteLength !== revision.byteSize) return { ...revision, available: false, integrity: "mismatch", relativePath };
    try { validatePrototypeHtml(bytes.toString("utf8"), revision.mediaType); }
    catch { return { ...revision, available: false, integrity: "policy-unknown", relativePath }; }
    return { ...revision, available: true, integrity: "verified", relativePath };
  }
}

function parseManifest(value: unknown, taskId: string): TaskPrototypeManifest {
  if (!value || typeof value !== "object") throw new Error("malformed prototype manifest");
  const m = value as Partial<TaskPrototypeManifest>;
  if (m.schemaVersion !== TASK_PROTOTYPE_SCHEMA_VERSION) throw new Error("unknown prototype manifest schema version");
  if (m.taskId !== taskId || typeof m.updatedAt !== "string" || !Array.isArray(m.prototypes)) throw new Error("malformed prototype manifest");
  const ids = new Set<string>();
  let approved = 0;
  for (const p of m.prototypes) {
    if (!p || typeof p !== "object" || !/^p-[0-9a-f]{12}$/.test(p.id) || ids.has(p.id)) throw new Error("malformed prototype revision");
    ids.add(p.id);
    assertSha(p.sha256);
    if (!Number.isSafeInteger(p.byteSize) || p.byteSize <= 0 || !Number.isSafeInteger(p.decodedDataBytes) || p.decodedDataBytes < 0) throw new Error("malformed prototype sizes");
    if (p.mediaType !== "text/html" || typeof p.title !== "string" || typeof p.author !== "string" || !["draft", "approved", "superseded", "rejected"].includes(p.state)) throw new Error("malformed prototype metadata");
    if (!Array.isArray(p.reviews) || typeof p.createdAt !== "string") throw new Error("malformed prototype history");
    if (Buffer.byteLength(p.title, "utf8") > TASK_PROTOTYPE_TITLE_MAX || Buffer.byteLength(p.author, "utf8") > 64 || !p.title.trim() || !p.author.trim()) throw new Error("malformed prototype authored metadata");
    for (const review of p.reviews) {
      if (!review || typeof review !== "object" || !["note", "approved", "rejected"].includes(review.action) || review.by !== "human" || typeof review.at !== "string" || review.sha256 !== p.sha256) throw new Error("malformed prototype review");
      if (review.text !== undefined && (typeof review.text !== "string" || !review.text.trim() || Buffer.byteLength(review.text, "utf8") > TASK_PROTOTYPE_REVIEW_MAX)) throw new Error("malformed prototype review text");
    }
    if (p.state === "approved") approved++;
    if (p.state === "superseded" && (!p.supersededBy || p.supersededBy === p.id)) throw new Error("malformed prototype supersession");
    if ((p.approvedAt !== undefined || p.approvedBy !== undefined) && p.approvedBy !== "human") throw new Error("malformed prototype approval");
    if (p.state === "approved" && (typeof p.approvedAt !== "string" || p.approvedBy !== "human" || p.supersededBy !== undefined)) throw new Error("malformed approved prototype");
    if ((p.state === "draft" || p.state === "rejected") && (p.approvedAt !== undefined || p.approvedBy !== undefined || p.supersededBy !== undefined)) throw new Error("malformed prototype transition history");
    if (p.state !== "superseded" && p.supersededBy !== undefined) throw new Error("malformed prototype supersession");
  }
  if (approved > 1) throw new Error("prototype manifest has multiple approved anchors");
  for (const p of m.prototypes) if (p.supersededBy && !ids.has(p.supersededBy)) throw new Error("prototype supersession target is missing");
  return m as TaskPrototypeManifest;
}

function bounded(value: string, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > max) throw new Error(`${label} must be 1-${max} bytes`);
  return trimmed;
}

function assertSha(value: string): void { if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid prototype sha256"); }

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try { fs.writeFileSync(tmp, content); fs.renameSync(tmp, target); }
  catch (err) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } throw err; }
}
