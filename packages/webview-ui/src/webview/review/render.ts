/**
 * SDD 513 fatia 2 — pure render decisions for one ReviewDiffFileV1.
 *
 * The 20_000-character highlight cut lives here, not in the engine. Above the
 * limit the screen escapes every line and says so; silent degrade is forbidden.
 */
import type { ReviewDiffFileV1, ReviewDiffHunkV1, ReviewDiffLineV1 } from "@tachyon/engine/runtime-api/reviewProjection.js";
import { escapeText, highlight, langFromPath } from "./highlight";

/** Fatia 0 measurement: above this, highlight.js blocks the webview (78.9 ms median on the largest real file). */
export const HIGHLIGHT_CHAR_LIMIT = 20_000;

export const HIGHLIGHT_DISABLED_BANNER = "Highlighting disabled for this file (large)";

export type ReviewRenderLine = {
  kind: ReviewDiffLineV1["kind"];
  text: string;
  html: string;
  oldLine: number | null;
  newLine: number | null;
  noNewline: boolean;
  annotatable: boolean;
};

export type ReviewRenderHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ReviewRenderLine[];
};

export type ReviewRenderModel = {
  path: string;
  from?: string;
  status: ReviewDiffFileV1["status"];
  binary: boolean;
  highlight: boolean;
  highlightBanner: string | undefined;
  hunks: ReviewRenderHunk[];
};

/** Characters we would hand to highlight.js — every hunk line, never truncated by the engine. */
export function highlightableCharCount(file: Pick<ReviewDiffFileV1, "hunks">): number {
  let n = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) n += line.text.length;
  }
  return n;
}

export function shouldHighlight(file: Pick<ReviewDiffFileV1, "binary" | "hunks">): boolean {
  if (file.binary) return false;
  return highlightableCharCount(file) <= HIGHLIGHT_CHAR_LIMIT;
}

export function hunkHeaderText(hunk: Pick<ReviewDiffHunkV1, "oldStart" | "oldLines" | "newStart" | "newLines" | "header">): string {
  const old = hunk.oldLines === 1 ? `-${hunk.oldStart}` : `-${hunk.oldStart},${hunk.oldLines}`;
  const neu = hunk.newLines === 1 ? `+${hunk.newStart}` : `+${hunk.newStart},${hunk.newLines}`;
  return hunk.header ? `@@ ${old} ${neu} @@ ${hunk.header}` : `@@ ${old} ${neu} @@`;
}

export function renderReviewDiff(file: ReviewDiffFileV1): ReviewRenderModel {
  const enabled = shouldHighlight(file);
  const lang = langFromPath(file.path);
  return {
    path: file.path,
    ...(file.from ? { from: file.from } : {}),
    status: file.status,
    binary: file.binary,
    highlight: enabled,
    highlightBanner: enabled ? undefined : file.binary ? undefined : HIGHLIGHT_DISABLED_BANNER,
    hunks: file.binary ? [] : file.hunks.map((hunk) => ({
      header: hunkHeaderText(hunk),
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines.map((line) => renderLine(line, enabled, lang)),
    })),
  };
}

function renderLine(line: ReviewDiffLineV1, enabled: boolean, lang?: string): ReviewRenderLine {
  const html = enabled
    ? (line.text.length ? highlight(line.text, lang) : "&nbsp;")
    : (line.text.length ? escapeText(line.text) : "&nbsp;");
  return {
    kind: line.kind,
    text: line.text,
    html,
    oldLine: line.oldLine,
    newLine: line.newLine,
    noNewline: line.noNewline === true,
    // Notes attach on the modified side only (SDD 511 side: "modified" ≡ newLine).
    annotatable: line.newLine !== null,
  };
}
