import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
    this.write(pins);
    return pin;
  }

  remove(id: string): void {
    const pins = this.list();
    if (!pins.some((p) => p.id === id)) throw new Error(`unknown pin '${id}'`);
    this.write(pins.filter((p) => p.id !== id));
  }

  private write(pins: Pin[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.pinsPath, `${JSON.stringify({ pins }, null, 2)}\n`, "utf8");
  }
}
