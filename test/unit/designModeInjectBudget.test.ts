/**
 * t-348c9a — freeze designModeInject.ts size until hybrid D shrinks the inject surface.
 * Raise ceilings only with an explicit PR that migrates chrome out of the string inject.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const injectPath = path.join(
  process.cwd(),
  "src/webview/ide-browser-bridge/designModeInject.ts",
);

/** Frozen at t-348c9a land — do not raise without hybrid-D (t-64edaf) or explicit budget review. */
/** Measured at t-348c9a land (split('\n').length includes final newline row). */
const MAX_LINES = 1721;
const MAX_BYTES = 68_000;

describe("designModeInject size budget (t-348c9a)", () => {
  it("keeps the inject source at or under the frozen ceiling", () => {
    const text = fs.readFileSync(injectPath, "utf8");
    const lines = text.split("\n").length;
    const bytes = Buffer.byteLength(text, "utf8");
    expect(lines, `lines ${lines} > ${MAX_LINES}`).toBeLessThanOrEqual(MAX_LINES);
    expect(bytes, `bytes ${bytes} > ${MAX_BYTES}`).toBeLessThanOrEqual(MAX_BYTES);
  });
});
