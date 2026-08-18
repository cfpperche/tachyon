/**
 * t-832633 — standalone preview fixture for the fatia 2 review screen.
 * Loaded by review-fatia2.html (not the catalog ROUTES table: that needs a
 * WEBVIEW_SURFACES host, which is fatia 3).
 */
const PATH = "packages/engine/src/workspace/Workspace.ts";

function padSource() {
  const line = "  export function measuredWorkspaceLine(index: number, payload: string): string { return `row-${index}:${payload}` + payload; } // padding-padding-padding-padding-padding-padding-padding-padding\n";
  let body = "export class Workspace {\n";
  while (body.length < 24_000) body += line;
  body += "}\n";
  return body;
}

function hunkFrom(source) {
  const lines = source.replace(/\n$/, "").split("\n");
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    header: "class Workspace",
    lines: lines.map((text, i) => ({
      kind: "add",
      text,
      oldLine: null,
      newLine: i + 1,
    })),
  };
}

const source = padSource();

window.__REVIEW_FATIA2_VM__ = {
  worktree: "reviewgrok",
  baseRef: "2778ccc4",
  currentLabel: "worktree",
  k: 3,
  files: [
    { status: "A", path: PATH },
    { status: "D", path: "packages/engine/src/commands/CommandRunner.ts" },
    { status: "A", path: "media/icon.png" },
  ],
  selectedPath: PATH,
  diff: {
    schemaVersion: 1,
    format: "unified",
    worktree: "reviewgrok",
    path: PATH,
    status: "A",
    baseRef: "2778ccc4",
    currentLabel: "worktree",
    binary: false,
    hunks: [hunkFrom(source)],
  },
  notes: [
    {
      schemaVersion: 1,
      identity: { worktree: "reviewgrok", baseRef: "2778ccc4", path: PATH, side: "modified", commentId: "c-mig" },
      snapshot: { line: 8, lineText: "export class Workspace {", before: [], after: [], k: 3 },
      body: "migrated with the file — keep the constructor contract",
      status: "active",
      range: { startLine: 1, endLine: 1 },
      lastPath: PATH,
      lastLine: 1,
      lastReconcile: { kind: "migrated", fromLine: 8, toLine: 1, fromPath: PATH, toPath: PATH },
    },
    {
      schemaVersion: 1,
      identity: { worktree: "reviewgrok", baseRef: "2778ccc4", path: PATH, side: "modified", commentId: "c-old" },
      snapshot: { line: 40, lineText: "removed helper", before: [], after: [], k: 3 },
      body: "outdated — the helper this pointed at was deleted",
      status: "outdated",
      outdatedReason: "deleted",
      range: { startLine: 40, endLine: 40 },
      lastPath: PATH,
      lastLine: 999999,
      lastReconcile: { kind: "outdated", fromLine: 40, toLine: 40, fromPath: PATH, toPath: PATH, reason: "deleted" },
    },
  ],
  agents: [{ name: "claude", detail: "coordenador" }],
};
