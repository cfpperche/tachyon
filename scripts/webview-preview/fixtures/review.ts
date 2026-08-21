/**
 * SDD 513 fatia 3 — catalog fixture for the Tachyon review tab.
 * Compact: one file, a few lines, two notes (migrated + outdated).
 */
import type { ReviewVM } from "@tachyon/webview-ui/webview/review/messages";
import type { Fixture } from "../routes";

const PATH = "src/a.ts";

function note(over: {
  commentId: string;
  lastLine: number;
  status: "active" | "outdated";
  kind: "migrated" | "outdated";
  body: string;
}): ReviewVM["notes"][number] {
  return {
    schemaVersion: 1,
    identity: {
      commentId: over.commentId,
      worktree: "reviewgrok",
      path: PATH,
      side: "modified",
      baseRef: "abc1234",
    },
    body: over.body,
    status: over.status,
    lastPath: PATH,
    lastLine: over.lastLine,
    range: { startLine: over.lastLine, endLine: over.lastLine },
    snapshot: { line: over.lastLine, lineText: "const target = 1;", before: ["keep"], after: ["delta"], k: 3 },
    lastReconcile: {
      kind: over.kind,
      fromLine: over.kind === "migrated" ? 8 : over.lastLine,
      toLine: over.lastLine,
      fromPath: PATH,
      toPath: PATH,
      ...(over.status === "outdated" ? { reason: "deleted" as const } : {}),
    },
    ...(over.status === "outdated" ? { outdatedReason: "deleted" as const } : {}),
  };
}

const vm: ReviewVM = {
  worktree: "reviewgrok",
  baseRef: "abc1234",
  currentLabel: "worktree",
  k: 3,
  files: [{ status: "M", path: PATH }],
  selectedPath: PATH,
  notes: [
    note({ commentId: "c-mig", lastLine: 1, status: "active", kind: "migrated", body: "caller is wrong" }),
    note({ commentId: "c-old", lastLine: 40, status: "outdated", kind: "outdated", body: "line gone" }),
  ],
  agents: [{ name: "reviewgrok", detail: "running" }],
  diff: {
    schemaVersion: 1,
    format: "unified",
    worktree: "reviewgrok",
    path: PATH,
    status: "M",
    baseRef: "abc1234",
    currentLabel: "worktree",
    binary: false,
    hunks: [{
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: "",
      lines: [
        { kind: "context", text: "keep", oldLine: 1, newLine: 1 },
        { kind: "del", text: "const was = 0;", oldLine: 2, newLine: null },
        { kind: "add", text: "const target = 1;", oldLine: null, newLine: 2 },
        { kind: "context", text: "delta", oldLine: 3, newLine: 3 },
      ],
    }],
  },
};

const LONG_PREFIX = "apps/vscode-extension/media/companion-mobile";
const LONG_MAP = `${LONG_PREFIX}/app.js.map`;

const longPathsVm: ReviewVM = {
  ...vm,
  files: [
    { status: "M", path: LONG_MAP },
    { status: "M", path: `${LONG_PREFIX}/app.js` },
    { status: "A", path: `${LONG_PREFIX}/index.html` },
    { status: "M", path: PATH },
  ],
  selectedPath: LONG_MAP,
  notes: [],
  diff: {
    schemaVersion: 1,
    format: "unified",
    worktree: "reviewgrok",
    path: LONG_MAP,
    status: "M",
    baseRef: "abc1234",
    currentLabel: "worktree",
    binary: false,
    hunks: [{
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      header: "",
      lines: [
        { kind: "context", text: "{\"version\":3}", oldLine: 1, newLine: 1 },
        { kind: "add", text: "{\"version\":3,\"file\":\"app.js\"}", oldLine: null, newLine: 2 },
      ],
    }],
  },
};

export const reviewFixtures: Record<string, Fixture<ReviewVM>> = {
  default: { provenance: "synthetic-edge", vm },
  "long-paths": { provenance: "synthetic-edge", vm: longPathsVm },
  raster: { provenance: "synthetic-edge", vm: binaryVm("raster", "png", "/docs/research/evidence-t-91884b/menu-open-880-light.png") },
  svg: { provenance: "synthetic-edge", vm: binaryVm("svg", "svg", "/docs/research/evidence-t-3be62b/sample.svg") },
  pdf: { provenance: "synthetic-edge", vm: binaryVm("pdf", "pdf", "/docs/research/evidence-t-3be62b/sample.pdf") },
  model: { provenance: "synthetic-edge", vm: binaryVm("model", "gltf", "/docs/research/evidence-t-3be62b/sample.gltf") },
};

function binaryVm(family: NonNullable<ReviewVM["binaryAsset"]>["family"], extension: string, uri: string): ReviewVM {
  const file = `evidence/sample.${extension}`;
  return {
    ...vm, files: [{ status: "A", path: file }], selectedPath: file, notes: [],
    diff: { schemaVersion: 1, format: "unified", worktree: "reviewgrok", path: file, status: "A", baseRef: "abc1234", currentLabel: "worktree", binary: true, hunks: [] },
    binaryAsset: { family, sides: [{ side: "current", label: "Current", uri }] },
  };
}
