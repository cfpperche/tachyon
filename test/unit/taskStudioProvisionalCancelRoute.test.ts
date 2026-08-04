import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-c3c819 — same tolerant-source-scan pattern studioCrossStudioResidue.test.ts /
 * richDocEditorMountRace.test.ts use for webview/host behavior this codebase has no DOM/Preact
 * rendering harness for (no @testing-library/preact anywhere in test/unit).
 *
 * Bug: "New Task" opens straight into `studio-edit` with a pre-minted, not-yet-saved id (Task
 * Studio's staged-create pattern, mintTaskId()) — never `studio-new`. `parentRoute()`
 * unconditionally treats every task studio-edit route's parent as `task-detail(entityId)`, correct
 * for a REAL edit but not for a brand-new task that was never saved: task-detail(id) 404s ("never
 * found on disk"). Both Cancel (Cockpit.ts's onCancelled hook) and the "← Board" breadcrumb
 * (cockpit/App.tsx) drove straight into that dead end.
 *
 * Fix: `Binding.persisted` (already tracked host-side for abandonProvisionalIfNeeded) now also
 * reaches the client via `CockpitModel.studioPersisted` and the `onCancelled(persisted)` hook
 * argument; both consumers fall back to the studio's own section instead of task-detail when
 * `persisted` is false.
 */
describe("Task Studio provisional-new Cancel/Back stays on Board (t-c3c819)", () => {
  it("model.ts: CockpitModel declares studioPersisted", () => {
    const src = readFileSync("src/cockpit/model.ts", "utf8");
    expect(src).toMatch(/studioPersisted\?:\s*boolean/);
  });

  it("studioHost.ts: currentStudioBindingFor exposes persisted, and onCancelled receives the value captured before abandonProvisionalIfNeeded's flip", () => {
    const src = readFileSync("src/cockpit/studioHost.ts", "utf8");
    expect(src).toMatch(/currentStudioBindingFor\(route: CockpitRoute\): \{ mountNonce: string; persisted: boolean \}/);
    expect(src).toContain("persisted: binding.persisted");
    expect(src).toContain("onCancelled: (persisted: boolean) => void");

    // the capture must happen BEFORE abandonProvisionalIfNeeded (which flips b.persisted to true
    // unconditionally as part of its own idempotency guard) and be what's passed to onCancelled —
    // reading b.persisted AFTER that call would always observe true.
    const cancelCaseAt = src.indexOf('case "cancel":');
    expect(cancelCaseAt).toBeGreaterThan(-1);
    const cancelCase = src.slice(cancelCaseAt, cancelCaseAt + 1200);
    const captureAt = cancelCase.indexOf("const wasPersisted = b.persisted;");
    const abandonAt = cancelCase.indexOf("abandonProvisionalIfNeeded(b);");
    const invokeAt = cancelCase.indexOf("hooks.onCancelled(wasPersisted);");
    expect(captureAt).toBeGreaterThan(-1);
    expect(abandonAt).toBeGreaterThan(captureAt);
    expect(invokeAt).toBeGreaterThan(abandonAt);
  });

  it("Cockpit.ts: the shared studioExitTarget helper falls back to a renderable section instead of task-detail when the binding was never persisted", () => {
    // t-527767 — this logic moved out of onCancelled's own body and into a helper shared with
    // onSaved (identical "where does this route's exit land" computation for both triggers); the
    // behavior this test guards is unchanged, only where the source lives.
    const src = readFileSync("src/webview/Cockpit.ts", "utf8");
    const helperAt = src.indexOf("const studioExitTarget = (route: StudioRoute, persisted: boolean): CockpitRoute => {");
    expect(helperAt).toBeGreaterThan(-1);
    const helperBody = src.slice(helperAt, helperAt + 400);
    expect(helperBody).toMatch(/parent\?\.kind === "task-detail" && !persisted/);
    // SDD 485 C5 — the fallback SECTION changed (the Board left Control for its own app, and `navigate()`
    // would turn a section("mission") here into "open a Board tab" — a panel appearing on a CANCEL). The
    // rule this test exists for did not: a never-persisted task's exit must not go to task-detail(id).
    expect(helperBody).toContain('routes.section("overview")');
    expect(helperBody, "the never-persisted branch must not route to task-detail").not.toContain("routes.taskDetail");

    const hookAt = src.indexOf("onCancelled: (persisted) => {");
    expect(hookAt).toBeGreaterThan(-1);
    expect(src.slice(hookAt, hookAt + 300)).toContain("navigate(studioExitTarget(currentRoute, persisted));");
  });

  it("cockpit/App.tsx: no retired Task Studio breadcrumb can reintroduce the dead detail route", () => {
    const src = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    expect(src).not.toContain('parent && parent.kind === "task-detail"');
    expect(src).not.toContain("navigateStudioParentAction");
    expect(src).not.toContain("control-studio-breadcrumb");
  });
});
