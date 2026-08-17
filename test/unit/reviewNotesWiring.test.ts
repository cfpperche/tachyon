import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isWorkspaceQueryResultBoundToInput,
  workspaceReviewMutationSuccessV1,
  workspaceReviewNotesViewSuccessV1,
} from "@tachyon/engine/engine-service/protocol.js";
import { applyReviewMutation, projectReviewNotes } from "@tachyon/engine/worktree/reviewNotesService.js";
import { loadReviewNotes } from "@tachyon/engine/worktree/reviewNotesStore.js";

/**
 * t-115091 / SDD 511 fatia 2 — protocol doors, not slice-1 reconciliation.
 *
 * These tests go through applyReviewMutation + projectReviewNotes, the same
 * functions the engine query/command handlers call. k is a TEST value.
 */
const K = 2;
const WORKTREE = "notasgrok";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): { root: string; checkout: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-review-wire-"));
  dirs.push(root);
  const checkout = path.join(root, "wt");
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
  return { root, checkout };
}

function originalFile(): string {
  return ["alpha", "beta", "const target = 1;", "delta", "epsilon"].join("\n") + "\n";
}

function writeFile(checkout: string, rel: string, content: string): void {
  const full = path.join(checkout, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function upsertInput(over: Record<string, unknown> = {}) {
  return {
    action: "note.upsert" as const,
    id: "c-1",
    worktree: WORKTREE,
    baseRef: "abc1234",
    path: "src/a.ts",
    body: "check the caller",
    line: 3,
    k: K,
    ...over,
  };
}

describe("t-115091 — review note protocol wiring (SDD 511 fatia 2)", () => {
  it("read returns a migrated note after displacement, not the raw persisted line", () => {
    const { root, checkout } = workspace();
    writeFile(checkout, "src/a.ts", originalFile());
    const created = applyReviewMutation({ workspaceRoot: root, checkoutRoot: checkout, rawInput: upsertInput() });
    expect(created).toEqual({ action: "note.upsert", id: "c-1", changed: true });

    const persisted = loadReviewNotes(root, WORKTREE);
    expect(persisted[0]?.lastLine).toBe(3);
    expect(persisted[0]?.range).toEqual({ startLine: 3, endLine: 3 });

    writeFile(checkout, "src/a.ts", ["inserted", "alpha", "beta", "const target = 1;", "delta", "epsilon"].join("\n") + "\n");
    const view = projectReviewNotes({ workspaceRoot: root, checkoutRoot: checkout, worktree: WORKTREE, k: K });
    const result = workspaceReviewNotesViewSuccessV1(view);
    expect(result).toMatchObject({ method: "review.view", status: "ok" });
    if (result.status !== "ok" || result.method !== "review.view") throw new Error("expected review.view");
    expect(isWorkspaceQueryResultBoundToInput(
      { schemaVersion: 1, method: "review.view", input: { worktree: WORKTREE, k: K } },
      result,
    )).toBe(true);

    expect(result.view.notes).toHaveLength(1);
    const note = result.view.notes[0]!;
    expect(note.status).toBe("active");
    expect(note.lastLine).toBe(4);
    expect(note.range).toEqual({ startLine: 4, endLine: 4 });
    expect(note.lastLine).not.toBe(persisted[0]?.lastLine);
    expect(note.lastReconcile?.kind).toBe("migrated");
    expect(note.body).toBe("check the caller");
  });

  it("read returns outdated after the anchored line is deleted", () => {
    const { root, checkout } = workspace();
    writeFile(checkout, "src/a.ts", originalFile());
    applyReviewMutation({ workspaceRoot: root, checkoutRoot: checkout, rawInput: upsertInput() });
    writeFile(checkout, "src/a.ts", ["alpha", "beta", "delta", "epsilon"].join("\n") + "\n");

    const view = projectReviewNotes({ workspaceRoot: root, checkoutRoot: checkout, worktree: WORKTREE, k: K });
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0]?.status).toBe("outdated");
    expect(view.notes[0]?.outdatedReason).toBe("deleted");
    expect(view.notes[0]?.lastLine).toBe(3);
    expect(view.notes[0]?.range).toEqual({ startLine: 3, endLine: 3 });
    expect(view.notes[0]?.body).toBe("check the caller");
    expect(view.notes[0]?.lastReconcile?.kind).toBe("outdated");
  });

  it("accepts a pushed range as a hint and lets the snapshot win when they disagree", () => {
    const { root, checkout } = workspace();
    writeFile(checkout, "src/a.ts", originalFile());
    applyReviewMutation({ workspaceRoot: root, checkoutRoot: checkout, rawInput: upsertInput() });
    const hinted = applyReviewMutation({
      workspaceRoot: root,
      checkoutRoot: checkout,
      rawInput: {
        action: "note.hint",
        id: "c-1",
        worktree: WORKTREE,
        hintRange: { startLine: 40, endLine: 40 },
      },
    });
    expect(hinted).toEqual({ action: "note.hint", id: "c-1", changed: true });
    const command = {
      schemaVersion: 1 as const,
      method: "review.mutate" as const,
      input: {
        action: "note.hint" as const,
        id: "c-1",
        worktree: WORKTREE,
        hintRange: { startLine: 40, endLine: 40 },
      },
    };
    expect(workspaceReviewMutationSuccessV1(command, hinted)).toMatchObject({
      method: "review.mutate",
      action: "note.hint",
      id: "c-1",
      changed: true,
    });

    writeFile(checkout, "src/a.ts", ["inserted", "alpha", "beta", "const target = 1;", "delta", "epsilon"].join("\n") + "\n");
    const view = projectReviewNotes({ workspaceRoot: root, checkoutRoot: checkout, worktree: WORKTREE, k: K });
    const note = view.notes[0]!;
    expect(note.status).toBe("active");
    expect(note.lastLine).toBe(4);
    expect(note.range.startLine).toBe(4);
    expect(note.range.startLine).not.toBe(40);
    expect(note.hintRange).toEqual({ startLine: 40, endLine: 40 });
    expect(note.lastReconcile?.hintDisagreed).toEqual({
      hint: { startLine: 40, endLine: 40 },
      derived: { startLine: 4, endLine: 4 },
    });
  });

  it("the engine query door calls projectReviewNotes, not a raw loadReviewNotes", () => {
    const source = fs.readFileSync("packages/engine/src/engine-service/engineService.ts", "utf8");
    const queryFn = source.slice(source.indexOf("async function executeWorkspaceQuery"), source.indexOf("async function executeWorkspaceCommand"));
    expect(queryFn).toContain('query.method === "review.view"');
    expect(queryFn).toContain("projectReviewNotes");
    expect(queryFn).not.toContain("loadReviewNotes");
    const commandFn = source.slice(source.indexOf("async function executeWorkspaceCommand"));
    expect(commandFn).toContain('command.method === "review.mutate"');
    expect(commandFn).toContain("applyReviewMutation");
  });
});
