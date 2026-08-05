import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withProcessLockSync } from "../locks/processLock.js";
import { PinAttachmentStore, type PinAttachment, type ResolvedPinAttachment } from "./PinAttachmentStore.js";
import type { TiptapJSON } from "./types.js";

export type { TiptapJSON } from "./types.js";

/**
 * Shared human↔agent project checklist, stored as a plain file in the workspace so
 * every consumer has a door: the sidebar (humans), Bridge tools (MCP agents),
 * and the file itself (agents without MCP; git, if the team wants it tracked —
 * that's the project's call, not Tachyon's).
 *
 *   .tachyon/pins.json — structured checklist (sidebar checkboxes need fields)
 *
 * (The old free-form notes whiteboard was retired in spec 253 — pins cover
 * discrete items; the project handoff covers narrative coordination state.)
 */

export interface Pin {
  id: string;
  text: string;
  /** self-declared author: "human" (sidebar/command) or an agent name */
  by: string;
  createdAt: string;
  updatedAt?: string;
  done: boolean;
  tags?: string[];
  detail?: boolean;
  attachmentCount?: number;
}

export interface PinDetail {
  schemaVersion: 1 | 2;
  pinId: string;
  doc: TiptapJSON;
  attachments: PinAttachment[];
}

export interface PinDetailRead {
  summary: Pin;
  detail: boolean;
  doc: TiptapJSON | null;
  attachments: ResolvedPinAttachment[];
}

export interface SavePinDetailInput {
  text: string;
  doc: TiptapJSON;
  attachments?: PinAttachment[];
  tags?: string[];
  now?: string;
}

export interface UpdatePinInput {
  text?: string;
  tags?: string[];
  now?: string;
}

/** Reserve a Pin document identity before its staged create is persisted. */
export function mintPinId(): string {
  return `p-${crypto.randomBytes(3).toString("hex")}`;
}

export class PinStore {
  private static readonly lockTimeoutMs = 5_000;
  private static readonly lockPollMs = 10;

  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon");
  }

  get pinsPath(): string {
    return path.join(this.dir, "pins.json");
  }

  get pinDetailsDir(): string {
    return path.join(this.dir, "pins");
  }

  list(): Pin[] {
    return this.readPins();
  }

  private readPins(): Pin[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.pinsPath, "utf8");
    } catch {
      return []; // not created yet
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`.tachyon/pins.json is not valid JSON — fix or delete it`);
    }
    const pins = (parsed as { pins?: unknown }).pins;
    if (!Array.isArray(pins)) {
      throw new Error(`.tachyon/pins.json must be {"pins": [...]}`);
    }
    return pins.map(normalizePinRecord);
  }

  create(text: string, by: string, opts: { tags?: string[]; now?: string; id?: string } = {}): Pin {
    const t = text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    const pin: Pin = {
      id: opts.id ?? mintPinId(),
      text: t,
      by,
      createdAt: opts.now ?? new Date().toISOString(),
      done: false,
    };
    applyTags(pin, opts.tags);
    this.mutatePins((pins) => {
      if (pins.some((candidate) => candidate.id === pin.id)) throw new Error(`pin '${pin.id}' already exists`);
      return [...pins, pin];
    });
    return pin;
  }

  setDone(id: string, done: boolean): Pin {
    let updated: Pin | undefined;
    this.mutatePins((pins) => {
      const pin = pins.find((p) => p.id === id);
      if (!pin) throw new Error(`unknown pin '${id}'`);
      pin.done = done;
      updated = pin;
      return pins;
    });
    const pin = updated;
    if (!pin) throw new Error(`unknown pin '${id}'`);
    return pin;
  }

  /** Edits a pin's text/tags in place; preserves id/by/createdAt/done (F4). */
  update(id: string, input: string | UpdatePinInput): Pin {
    const patch = typeof input === "string" ? { text: input } : input;
    if (patch.text === undefined && patch.tags === undefined) throw new Error("pin update requires text or tags");
    let updated: Pin | undefined;
    this.mutatePins((pins) => {
      const pin = pins.find((p) => p.id === id);
      if (!pin) throw new Error(`unknown pin '${id}'`);
      if (patch.text !== undefined) {
        const t = patch.text.trim();
        if (t.length === 0) throw new Error("pin text must be non-empty");
        pin.text = t;
      }
      if (patch.tags !== undefined) applyTags(pin, patch.tags);
      pin.updatedAt = patch.now ?? new Date().toISOString();
      updated = pin;
      return pins;
    });
    const pin = updated;
    if (!pin) throw new Error(`unknown pin '${id}'`);
    return pin;
  }

  remove(id: string): void {
    this.mutatePins((pins) => {
      if (!pins.some((p) => p.id === id)) throw new Error(`unknown pin '${id}'`);
      return pins.filter((p) => p.id !== id);
    });
    try { fs.rmSync(this.detailPath(id), { force: true }); } catch { /* best-effort local detail cleanup */ }
  }

  createRich(text: string, by: string, detail: Omit<SavePinDetailInput, "text"> & { id?: string }): Pin {
    const t = text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    const now = detail.now ?? new Date().toISOString();
    const pin: Pin = {
      id: detail.id ?? mintPinId(),
      text: t,
      by,
      createdAt: now,
      updatedAt: now,
      done: false,
      detail: true,
      attachmentCount: directVisualAttachmentCount(detail.doc, detail.attachments ?? []),
    };
    applyTags(pin, detail.tags);
    this.mutatePins((pins) => {
      if (pins.some((candidate) => candidate.id === pin.id)) throw new Error(`pin '${pin.id}' already exists`);
      this.writeDetailFile({ schemaVersion: 2, pinId: pin.id, doc: detail.doc, attachments: detail.attachments ?? [] });
      return [...pins, pin];
    });
    return pin;
  }

  saveDetail(id: string, input: SavePinDetailInput): Pin {
    const t = input.text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    let updated: Pin | undefined;
    this.mutatePins((pins) => {
      const pin = pins.find((p) => p.id === id);
      if (!pin) throw new Error(`unknown pin '${id}'`);
      this.writeDetailFile({ schemaVersion: 2, pinId: id, doc: input.doc, attachments: input.attachments ?? [] });
      pin.text = t;
      pin.updatedAt = input.now ?? new Date().toISOString();
      pin.detail = true;
      pin.attachmentCount = directVisualAttachmentCount(input.doc, input.attachments ?? []);
      if (input.tags !== undefined) applyTags(pin, input.tags);
      updated = pin;
      return pins;
    });
    const pin = updated;
    if (!pin) throw new Error(`unknown pin '${id}'`);
    return pin;
  }

  clearDetail(id: string, text: string, now = new Date().toISOString(), tags?: string[]): Pin {
    const t = text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    let updated: Pin | undefined;
    this.mutatePins((pins) => {
      const pin = pins.find((p) => p.id === id);
      if (!pin) throw new Error(`unknown pin '${id}'`);
      pin.text = t;
      pin.updatedAt = now;
      if (tags !== undefined) applyTags(pin, tags);
      delete pin.detail;
      delete pin.attachmentCount;
      updated = pin;
      return pins;
    });
    try { fs.rmSync(this.detailPath(id), { force: true }); } catch { /* best-effort local detail cleanup */ }
    const pin = updated;
    if (!pin) throw new Error(`unknown pin '${id}'`);
    return pin;
  }

  readDetail(id: string): PinDetailRead {
    const summary = this.requirePin(id);
    let raw: string;
    try {
      raw = fs.readFileSync(this.detailPath(id), "utf8");
    } catch {
      return { summary: { ...summary, detail: false, attachmentCount: summary.attachmentCount ?? 0 }, detail: false, doc: null, attachments: [] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`.tachyon/pins/${id}.json is not valid JSON — fix or delete it`);
    }
    const detail = parsed as Partial<PinDetail>;
    if ((detail.schemaVersion !== 1 && detail.schemaVersion !== 2) || detail.pinId !== id || !detail.doc || !Array.isArray(detail.attachments)) {
      throw new Error(`.tachyon/pins/${id}.json must be a schemaVersion 1 or 2 pin detail`);
    }
    for (const attachment of detail.attachments) assertPinAttachment(attachment);
    const attachments = new PinAttachmentStore(this.workspaceRoot);
    return {
      summary: { ...summary, detail: true, attachmentCount: directVisualAttachmentCount(detail.doc, detail.attachments) },
      detail: true,
      doc: detail.doc,
      attachments: detail.attachments.map((a) => attachments.resolveAttachment(a)),
    };
  }

  detailPath(id: string): string {
    if (!/^p-[0-9a-f]{6}$/.test(id)) throw new Error(`invalid pin id '${id}'`);
    return path.join(this.pinDetailsDir, `${id}.json`);
  }

  /**
   * Serialize the read-modify-write across processes (a second window, a Dev Host beside the host).
   *
   * The wait is SYNCHRONOUS and that is a known cost, registered rather than hidden (t-7843d0): this
   * class's whole API is synchronous and its largest consumer is `src/bridge/tools.ts`, so making it
   * async is a separate change with a much wider blast radius. Within one extension host these calls
   * cannot contend at all — the thread that would wait is the thread that would release.
   *
   * Uses the shared `withProcessLockSync` (t-b457ce reconvergence after t-099847's temporary
   * pin-local lock). Deliberately omits `maxHoldMs`: a lost pin is worse than waiting out a live
   * holder until `lockTimeoutMs`. Dead-pid orphan recovery stays on; age-steal stays off.
   */
  private mutatePins(update: (pins: Pin[]) => Pin[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    withProcessLockSync(this.lockPath, () => {
      this.write(update(this.readPins()));
    }, {
      timeoutMs: PinStore.lockTimeoutMs,
      pollMs: PinStore.lockPollMs,
      label: ".tachyon/pins.json mutation lock",
    });
  }

  private write(pins: Pin[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.pinsPath}.tmp.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ pins }, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tmp, this.pinsPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort tmp cleanup */ }
      throw err;
    }
  }

  private requirePin(id: string): Pin {
    const pin = this.list().find((p) => p.id === id);
    if (!pin) throw new Error(`unknown pin '${id}'`);
    return pin;
  }

  private writeDetailFile(detail: PinDetail): void {
    fs.mkdirSync(this.pinDetailsDir, { recursive: true });
    const p = this.detailPath(detail.pinId);
    const tmp = `${p}.tmp.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, `${JSON.stringify(detail, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, p);
  }

  /**
   * The cross-process lock the mutation path takes. Public so a test can hold the REAL lock from
   * another process and then be killed — a hand-made lock file would only prove the test's own shape.
   * Format is processLock's (file containing `${pid}\n`).
   */
  get lockPath(): string {
    return path.join(this.dir, "pins.json.lock");
  }
}

export function normalizePinTags(input: unknown, authoring = true): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string") continue;
    const tag = value.normalize("NFKC").trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
    if (!tag || (authoring && tag.length > 32) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (authoring && out.length >= 12) break;
  }
  return out;
}

function normalizePinRecord(value: unknown): Pin {
  const pin = value as Pin;
  const tags = normalizePinTags((pin as { tags?: unknown }).tags, false);
  if (tags.length > 0) return { ...pin, tags };
  const { tags: _tags, ...rest } = pin as Pin & { tags?: unknown };
  return rest;
}

function applyTags(pin: Pin, input: unknown): void {
  const tags = normalizePinTags(input);
  if (tags.length > 0) pin.tags = tags;
  else delete pin.tags;
}

function assertPinAttachment(value: PinAttachment): void {
  if (value.kind === "image") {
    if (!value.id || !value.blobRef || !value.mediaType || !value.name || typeof value.size !== "number") {
      throw new Error(`pin image attachment is missing required fields`);
    }
    return;
  }
  if (value.kind === "excalidraw") {
    if (!value.id || !value.sceneBlobRef || !value.previewBlobRef || !value.name || typeof value.sceneSize !== "number" || typeof value.previewSize !== "number") {
      throw new Error(`pin sketch attachment is missing required fields`);
    }
    return;
  }
  throw new Error(`pin attachment kind is not supported`);
}

function directVisualAttachmentCount(doc: TiptapJSON, attachments: PinAttachment[]): number {
  const ids = new Set<string>();
  const visit = (node: TiptapJSON): void => {
    if ((node.type === "image" || node.type === "tachyonSketch") && node.attrs) {
      const attachmentId = typeof node.attrs.attachmentId === "string" ? node.attrs.attachmentId : undefined;
      if (attachmentId) ids.add(attachmentId);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  if (ids.size === 0) return attachments.length;
  return attachments.filter((att) => ids.has(att.id)).length;
}
