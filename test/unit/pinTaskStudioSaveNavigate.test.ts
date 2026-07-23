import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-527767 — maintainer report 2026-07-23: saving Pin/Task Studio left the studio form open instead
 * of navigating away, unlike Cancel (which already navigates, per t-cdd4e1). Scope confirmed with
 * the maintainer: ONLY Pin and Task auto-navigate on save (the other 5 studios read more like config
 * editors, where staying open to keep tweaking is the better default); Task Studio specifically goes
 * to task-detail for an already-persisted edit, Board only for a brand-new task's first save (same
 * rule as Cancel/Back, t-c3c819).
 *
 * "Save-triggered auto-navigation" was explicitly out of scope for D2 (spec 410) after an
 * adversarial dueto found it unsafe without a larger atomic-transaction redesign (route.ts's
 * parentRoute doc comment, tasks.md). Re-examined here across 3 adversarial probe rounds before
 * landing: round 1 (no file access) and round 2 (an incomplete code excerpt on my part) both raised
 * a "stale save completion navigates an unrelated newer Studio" blocker; round 3, given the complete
 * unabridged `beginStudioSave` body, confirmed the PRE-EXISTING `if (!io.isCurrent() || binding !==
 * b) return;` guard (right after `await b.adapter.save(...)`, predates this change) already makes
 * that unreachable — but flagged one genuinely new gap: `hooks.onChanged()` runs between that guard
 * and `hooks.onSaved`, and nothing re-validated freshness in between if `onChanged` could ever
 * synchronously navigate. Traced `onChanged`'s real binding (`refreshAll`, extension.ts) end-to-end
 * and confirmed it never calls `navigate()` today — but added the same guard immediately after
 * `hooks.onChanged()` anyway as cheap defense-in-depth against a future `onChanged` implementation
 * gaining that ability. this file guards the client-side wiring's shape, source-scan pattern (no
 * DOM/Preact rendering harness in this codebase); studioHostProvisionalCleanup.test.ts exercises
 * onSaved's host-side firing behaviorally.
 */
describe("Pin/Task Studio Save navigates away (t-527767)", () => {
  it("studioHost.ts: StudioMessageHooks declares onSaved, fired after a successful save with the pre-flip persisted value", () => {
    const src = readFileSync("src/cockpit/studioHost.ts", "utf8");
    expect(src).toContain("onSaved: (persisted: boolean) => void;");

    const okBranchAt = src.indexOf('if (result.status === "ok") {');
    expect(okBranchAt).toBeGreaterThan(-1);
    const okBranch = src.slice(okBranchAt, okBranchAt + 2200);
    const captureAt = okBranch.indexOf("const wasPersisted = b.persisted;");
    const flipAt = okBranch.indexOf("b.persisted = true;");
    const onChangedAt = okBranch.indexOf("hooks.onChanged();");
    const invokeAt = okBranch.indexOf("hooks.onSaved(wasPersisted);");
    expect(captureAt).toBeGreaterThan(-1);
    expect(flipAt).toBeGreaterThan(captureAt);
    expect(onChangedAt).toBeGreaterThan(flipAt);
    expect(invokeAt).toBeGreaterThan(onChangedAt);

    // t-527767 (3rd adversarial probe round) — a freshness re-check immediately after
    // hooks.onChanged(), not just after the initial save await: defense-in-depth against a future
    // onChanged implementation gaining the ability to synchronously navigate (today's real binding,
    // extension.ts's `refreshAll`, does not).
    const postOnChanged = okBranch.slice(onChangedAt, invokeAt);
    expect(postOnChanged).toContain("if (!io.isCurrent() || binding !== b) return;");
  });

  it("Cockpit.ts: onSaved is scoped to Pin/Task only and reuses the same exit-target computation as onCancelled", () => {
    const src = readFileSync("src/webview/Cockpit.ts", "utf8");
    expect(src).toContain("const studioExitTarget = (route: StudioRoute, persisted: boolean): CockpitRoute => {");

    const onCancelledAt = src.indexOf("onCancelled: (persisted) => {");
    expect(onCancelledAt).toBeGreaterThan(-1);
    expect(src.slice(onCancelledAt, onCancelledAt + 300)).toContain("navigate(studioExitTarget(currentRoute, persisted));");

    const onSavedAt = src.indexOf("onSaved: (persisted) => {");
    expect(onSavedAt).toBeGreaterThan(-1);
    const onSavedBody = src.slice(onSavedAt, onSavedAt + 400);
    expect(onSavedBody).toContain('if (currentRoute.studio !== "pin" && currentRoute.studio !== "task") return;');
    expect(onSavedBody).toContain("navigate(studioExitTarget(currentRoute, persisted));");
  });
});
