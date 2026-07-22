import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-610705 (SDD 410 Phase D, D1a code-review finding) — two regressions the D1a probe review found
 * in the CLIENT-side webview code, which this codebase has no DOM/Preact-rendering test harness for
 * (no @testing-library/preact or preact-render-to-string usage anywhere in test/unit). Same
 * tolerant-source-scan pattern studioCutoverRouting.test.ts/cockpitCssParity.test.ts already use for
 * behavior that can't be driven through openCockpit()'s host-side integration harness: a real
 * behavioral test would need new rendering infrastructure this PR isn't the place to add, so this
 * guards the FIX'S SHAPE instead — weaker than a behavioral test, but strong enough that reverting
 * either fix (even accidentally, e.g. during a future refactor) fails CI instead of shipping silently.
 *
 * Bug 1 — cross-studio `studioIncoming` residue (cockpit/main.tsx): `studioIncoming` is ONE shared
 * state slot every studio App reads via its `incoming` prop. A studio-to-studio navigation (e.g.
 * Schedule → Terminal) fully unmounts+remounts the studio component (cockpit/App.tsx's explicit
 * `key`), but the NEW component's first render still receives whatever `studioIncoming` held from the
 * PREVIOUS studio — `decodeStudioMessage` only checks `type`/`studioProtocolVersion`, not the
 * studio-specific field shape, so a stale cross-studio `load` envelope is accepted as if it were the
 * new studio's own load. Concretely: Schedule's fields (no `cmd` field) land in Terminal's `fields`
 * state, then Terminal's render calls `firstToken(fields.cmd)` → `undefined.trim()` → a render-time
 * crash. Fixed by clearing `studioIncoming` the moment `studioMountNonce` changes, in the SAME
 * synchronous update as `setModel` (an effect-based clear would run too late — AFTER the new
 * component's first render already used the stale value).
 *
 * Bug 2 — Terminal Studio silently dropped `referenceData` pushes (terminal-studio-shell/App.tsx):
 * `refreshStudioReferenceData` (studioHost.ts) is generic over every StudioId, not gated to
 * Runbook/Schedule — an external tachyon.yml change while a Terminal Studio route is active pushes a
 * `referenceData` message to Terminal too. Runbook/Schedule handle it; Terminal's incoming-message
 * effect had no matching branch, so it fell through silently and flagMap/defaultCwd/verifyCandidates
 * went stale until the next full load (not a crash, but a real live-refresh regression).
 */

describe("D1a code-review fixes stay in place", () => {
  it("cockpit/main.tsx clears studioIncoming when studioMountNonce changes, in the same tick as setModel", () => {
    const src = readFileSync("src/webview/cockpit/main.tsx", "utf8");
    expect(src).toContain("studioMountNonceRef");
    // the comparison and the clear must both exist, and the clear must be a plain state setter call
    // (not, say, wrapped in its own separate useEffect — that would reintroduce the "too late" bug).
    expect(src).toMatch(/next\.studioMountNonce\s*!==\s*studioMountNonceRef\.current/);
    expect(src).toContain("setStudioIncoming(undefined)");
    // the clear must happen BEFORE setModel(next) in source order — same synchronous batch, and the
    // model (which drives which studio component is mounted) must not have already committed first.
    const clearAt = src.indexOf("setStudioIncoming(undefined)");
    const setModelAt = src.indexOf("setModel(next)");
    expect(clearAt).toBeGreaterThan(-1);
    expect(setModelAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(setModelAt);
  });

  it("terminal-studio-shell/App.tsx handles the referenceData core message (matches Runbook/Schedule)", () => {
    const src = readFileSync("src/webview/terminal-studio-shell/App.tsx", "utf8");
    expect(src).toMatch(/d\.type === "referenceData"/);
    expect(src).toContain("setReferenceData(d.referenceData ?? emptyReferenceData())");
  });
});
