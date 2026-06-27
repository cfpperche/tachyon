import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyEvidenceArtifacts } from "../../src/worktree/evidenceArtifacts.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "tach-evart-")); dirs.push(d); return d; }

describe("copyEvidenceArtifacts — durable evidence artifacts (spec 274)", () => {
  it("copies worktree artifacts into the managed dir and returns workspace-relative refs", () => {
    const ws = tmp();
    const wt = path.join(ws, "wt"); // a worktree under the workspace (location doesn't matter)
    fs.mkdirSync(path.join(wt, "shots"), { recursive: true });
    fs.writeFileSync(path.join(wt, "shots", "before.png"), "PNG-A");
    fs.writeFileSync(path.join(wt, "after.png"), "PNG-B");

    const r = copyEvidenceArtifacts({ workspaceRoot: ws, worktreePath: wt, agent: "rev", id: "ev-1", refs: ["shots/before.png", "after.png"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refs).toEqual([".tachyon/evidence/rev/ev-1/before.png", ".tachyon/evidence/rev/ev-1/after.png"]);
    // the copies exist under the managed dir + carry the original bytes
    expect(fs.readFileSync(path.join(ws, r.refs[0]), "utf8")).toBe("PNG-A");
    expect(fs.readFileSync(path.join(ws, r.refs[1]), "utf8")).toBe("PNG-B");
  });

  it("survives a worktree rebuild: the managed copy persists after the worktree is removed", () => {
    const ws = tmp();
    const wt = path.join(ws, "wt");
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, "shot.png"), "PNG");
    const r = copyEvidenceArtifacts({ workspaceRoot: ws, worktreePath: wt, agent: "rev", id: "ev-2", refs: ["shot.png"] });
    expect(r.ok).toBe(true);
    fs.rmSync(wt, { recursive: true, force: true }); // worktree gone
    if (r.ok) expect(fs.existsSync(path.join(ws, r.refs[0]))).toBe(true); // managed copy still there
  });

  it("fails cleanly when a source artifact is missing (no partial record)", () => {
    const ws = tmp();
    const wt = path.join(ws, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const r = copyEvidenceArtifacts({ workspaceRoot: ws, worktreePath: wt, agent: "rev", id: "ev-3", refs: ["gone.png"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not found in worktree: gone\.png/);
  });

  it("de-collides identical basenames within one record", () => {
    const ws = tmp();
    const wt = path.join(ws, "wt");
    fs.mkdirSync(path.join(wt, "a"), { recursive: true });
    fs.mkdirSync(path.join(wt, "b"), { recursive: true });
    fs.writeFileSync(path.join(wt, "a", "shot.png"), "A");
    fs.writeFileSync(path.join(wt, "b", "shot.png"), "B");
    const r = copyEvidenceArtifacts({ workspaceRoot: ws, worktreePath: wt, agent: "rev", id: "ev-4", refs: ["a/shot.png", "b/shot.png"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.refs).toEqual([".tachyon/evidence/rev/ev-4/shot.png", ".tachyon/evidence/rev/ev-4/1-shot.png"]);
    expect(fs.readFileSync(path.join(ws, r.refs[0]), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(ws, r.refs[1]), "utf8")).toBe("B");
  });

  it("rejects a symlink source (no durable copy of a file outside the worktree)", () => {
    const ws = tmp();
    const wt = path.join(ws, "wt");
    fs.mkdirSync(wt, { recursive: true });
    const outside = path.join(ws, "secret.txt");
    fs.writeFileSync(outside, "SECRET");
    fs.symlinkSync(outside, path.join(wt, "shot.png")); // symlink inside the worktree → outside
    const r = copyEvidenceArtifacts({ workspaceRoot: ws, worktreePath: wt, agent: "rev", id: "ev-sym", refs: ["shot.png"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/regular file/);
  });

  it("no artifacts → ok with empty refs", () => {
    const ws = tmp();
    const r = copyEvidenceArtifacts({ workspaceRoot: ws, worktreePath: ws, agent: "rev", id: "ev-5", refs: [] });
    expect(r).toEqual({ ok: true, refs: [] });
  });
});
