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

  it("Cockpit.ts: the shared studioExitTarget helper falls back to the mission section instead of task-detail when the binding was never persisted", () => {
    // t-527767 — this logic moved out of onCancelled's own body and into a helper shared with
    // onSaved (identical "where does this route's exit land" computation for both triggers); the
    // behavior this test guards is unchanged, only where the source lives.
    const src = readFileSync("src/webview/Cockpit.ts", "utf8");
    const helperAt = src.indexOf("const studioExitTarget = (route: StudioRoute, persisted: boolean): CockpitRoute => {");
    expect(helperAt).toBeGreaterThan(-1);
    const helperBody = src.slice(helperAt, helperAt + 400);
    expect(helperBody).toMatch(/parent\?\.kind === "task-detail" && !persisted/);
    expect(helperBody).toContain('routes.section("mission")');

    const hookAt = src.indexOf("onCancelled: (persisted) => {");
    expect(hookAt).toBeGreaterThan(-1);
    expect(src.slice(hookAt, hookAt + 300)).toContain("navigate(studioExitTarget(currentRoute, persisted));");
  });

  it("cockpit/App.tsx: the task-detail breadcrumb falls back to setSection(\"mission\") when studioPersisted is false", () => {
    const src = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    const breadcrumbAt = src.indexOf('parent && parent.kind === "task-detail"');
    expect(breadcrumbAt).toBeGreaterThan(-1);
    const breadcrumbRegion = src.slice(breadcrumbAt, breadcrumbAt + 1400);
    expect(breadcrumbRegion).toMatch(/m\.studioPersisted === false/);
    expect(breadcrumbRegion).toContain('p.onSetSection("mission")');
    // SDD 485 C4 — the persisted branch no longer navigates Control: the task detail is its own tab, so
    // the button asks the HOST for this studio route's parent (`navigateStudioParent`) and the host's
    // `navigate` turns that task-detail parent into "open the task's tab, land Control on the Board".
    // The `studioPersisted === false` fallback above is untouched, which is what this test is for.
    expect(breadcrumbRegion).toContain("navigateStudioParentAction(routeKey(activeRoute))");
  });
});
