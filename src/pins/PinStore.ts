import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Shared human↔agent project memory, stored as plain files in the workspace so
 * every consumer has a door: the sidebar (humans), Bridge tools (MCP agents),
 * and the files themselves (agents without MCP; git, if the team wants them
 * tracked — that's the project's call, not Tachyon's).
 *
 *   .tachyon/pins.json — structured checklist (sidebar checkboxes need fields)
 *   .tachyon/notes.md  — free-form whiteboard
 */

export interface Pin {
  id: string;
  text: string;
  /** self-declared author: "human" (sidebar/command) or an agent name */
  by: string;
  createdAt: string;
  done: boolean;
}

export class PinStore {
  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon");
  }

  get pinsPath(): string {
    return path.join(this.dir, "pins.json");
  }

  get notesPath(): string {
    return path.join(this.dir, "notes.md");
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

  remove(id: string): void {
    const pins = this.list();
    if (!pins.some((p) => p.id === id)) throw new Error(`unknown pin '${id}'`);
    this.write(pins.filter((p) => p.id !== id));
  }

  getNotes(): string {
    try {
      return fs.readFileSync(this.notesPath, "utf8");
    } catch {
      return "";
    }
  }

  setNotes(text: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.notesPath, text.endsWith("\n") || text === "" ? text : `${text}\n`, "utf8");
  }

  /** Ensures notes.md exists (for "open notes" UX). */
  ensureNotesFile(): string {
    if (!fs.existsSync(this.notesPath)) this.setNotes("");
    return this.notesPath;
  }

  private write(pins: Pin[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.pinsPath, `${JSON.stringify({ pins }, null, 2)}\n`, "utf8");
  }
}
