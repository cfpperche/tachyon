import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-668b05 — PrototypePreview.tsx's `selected.sha256.slice(0, 12)` was unguarded: `sha256` is only a
 * compile-time TypeScript guarantee (TaskPrototypeVM), never runtime-validated against the actual
 * on-disk manifest record it's read from (src/cockpit/taskDetailVm.ts) — a missing/malformed value
 * threw a TypeError synchronously during render, which (with no error boundary anywhere in Control at
 * the time) blanked the ENTIRE Cockpit panel to black. This repo has no DOM/Preact rendering test
 * harness (PrototypePreview also uses hooks internally, so it can't be called directly outside a real
 * render cycle either) — source-scan guard, same tolerant convention studioCutoverRouting.test.ts/
 * cockpitCssParity.test.ts already use for behavior that can't be driven through a host-side
 * integration test.
 */
describe("PrototypePreview guards a missing/malformed sha256 (t-668b05)", () => {
  it("does not call .slice() directly on selected.sha256 without a type/truthiness guard first", () => {
    const src = readFileSync("src/webview/shared/PrototypePreview.tsx", "utf8");
    expect(src).not.toMatch(/\{selected\.sha256\.slice\(/);
    expect(src).toMatch(/typeof selected\.sha256 === "string" && selected\.sha256/);
  });

  // t-668b05 (round-1 code-review finding) — the same class of bug (unvalidated on-disk data) could
  // ALSO crash at `.filter`/`.find`/`.some`/`.at`/`.map` on `value.prototypes` if it were ever a
  // non-array, BEFORE the sha256 guard is even reached — normalized once at the top instead.
  it("normalizes value.prototypes to an array before any array method call on it", () => {
    const src = readFileSync("src/webview/shared/PrototypePreview.tsx", "utf8");
    expect(src).toMatch(/const prototypes = Array\.isArray\(value\.prototypes\) \? value\.prototypes : \[\]/);
    // every subsequent array-method call site in the component uses the normalized local, not the
    // raw (unvalidated) `value.prototypes` field directly.
    expect(src).not.toMatch(/value\.prototypes\.(?:filter|find|some|at|map)\(/);
  });
});
