import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  detail?: boolean;
  attachmentCount?: number;
}

export interface PinDetail {
  schemaVersion: 1;
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
  now?: string;
}

export class PinStore {
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
    return pins as Pin[];
  }

  create(text: string, by: string): Pin {
    const pin: Pin = {
      id: `p-${crypto.randomBytes(3).toString("hex")}`,
      text: text.trim(),
      by,
      createdAt: new Date().toISOString(),
      done: false,
    };
    this.write([...this.list(), pin]);
    return pin;
  }

  setDone(id: string, done: boolean): Pin {
    const pins = this.list();
    const pin = pins.find((p) => p.id === id);
    if (!pin) throw new Error(`unknown pin '${id}'`);
    pin.done = done;
    this.write(pins);
    return pin;
  }

  /** Edits a pin's text in place; preserves id/by/createdAt/done (F4). */
  update(id: string, text: string): Pin {
    const pins = this.list();
    const pin = pins.find((p) => p.id === id);
    if (!pin) throw new Error(`unknown pin '${id}'`);
    const t = text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    pin.text = t;
    pin.updatedAt = new Date().toISOString();
    this.write(pins);
    return pin;
  }

  remove(id: string): void {
    const pins = this.list();
    if (!pins.some((p) => p.id === id)) throw new Error(`unknown pin '${id}'`);
    this.write(pins.filter((p) => p.id !== id));
    try { fs.rmSync(this.detailPath(id), { force: true }); } catch { /* best-effort local detail cleanup */ }
  }

  createRich(text: string, by: string, detail: Omit<SavePinDetailInput, "text">): Pin {
    const t = text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    const now = detail.now ?? new Date().toISOString();
    const pin: Pin = {
      id: `p-${crypto.randomBytes(3).toString("hex")}`,
      text: t,
      by,
      createdAt: now,
      updatedAt: now,
      done: false,
      detail: true,
      attachmentCount: detail.attachments?.length ?? 0,
    };
    this.writeDetailFile({ schemaVersion: 1, pinId: pin.id, doc: detail.doc, attachments: detail.attachments ?? [] });
    this.write([...this.list(), pin]);
    return pin;
  }

  saveDetail(id: string, input: SavePinDetailInput): Pin {
    const pins = this.list();
    const pin = pins.find((p) => p.id === id);
    if (!pin) throw new Error(`unknown pin '${id}'`);
    const t = input.text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    this.writeDetailFile({ schemaVersion: 1, pinId: id, doc: input.doc, attachments: input.attachments ?? [] });
    pin.text = t;
    pin.updatedAt = input.now ?? new Date().toISOString();
    pin.detail = true;
    pin.attachmentCount = input.attachments?.length ?? 0;
    this.write(pins);
    return pin;
  }

  clearDetail(id: string, text: string, now = new Date().toISOString()): Pin {
    const pins = this.list();
    const pin = pins.find((p) => p.id === id);
    if (!pin) throw new Error(`unknown pin '${id}'`);
    const t = text.trim();
    if (t.length === 0) throw new Error("pin text must be non-empty");
    pin.text = t;
    pin.updatedAt = now;
    delete pin.detail;
    delete pin.attachmentCount;
    this.write(pins);
    try { fs.rmSync(this.detailPath(id), { force: true }); } catch { /* best-effort local detail cleanup */ }
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
    if (detail.schemaVersion !== 1 || detail.pinId !== id || !detail.doc || !Array.isArray(detail.attachments)) {
      throw new Error(`.tachyon/pins/${id}.json must be a schemaVersion 1 pin detail`);
    }
    const attachments = new PinAttachmentStore(this.workspaceRoot);
    return {
      summary: { ...summary, detail: true, attachmentCount: detail.attachments.length },
      detail: true,
      doc: detail.doc,
      attachments: detail.attachments.map((a) => attachments.resolveAttachment(a)),
    };
  }

  detailPath(id: string): string {
    if (!/^p-[0-9a-f]{6}$/.test(id)) throw new Error(`invalid pin id '${id}'`);
    return path.join(this.pinDetailsDir, `${id}.json`);
  }

  private write(pins: Pin[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.pinsPath, `${JSON.stringify({ pins }, null, 2)}\n`, "utf8");
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
}
