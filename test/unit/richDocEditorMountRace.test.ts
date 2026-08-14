import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-112627 — same tolerant-source-scan pattern studioCrossStudioResidue.test.ts uses for webview
 * behavior this codebase has no DOM/Preact-rendering harness for (no @testing-library/preact
 * anywhere in test/unit).
 *
 * Bug: `resetEditorFrom` (pin-studio/App.tsx, task-studio/App.tsx) ran synchronously inside the
 * "load" message handler, in the SAME tick as the setEntity/setReady calls that cause StudioFrame's
 * richDoc region (gated on `ready && entity`) to render for the first time. `mount.current` was still
 * null at that point on a fresh binding — Preact hadn't re-rendered yet — so the
 * `if (mount.current) { ...createRichDocEditor... }` guard silently no-opped and the rich-doc editor
 * never mounted: clicking or typing in "New Pin"/"New Task" (and any first-load edit) did nothing,
 * with no console error. Confirmed via git-bisect against the commit before this session's Pin Studio
 * work that this predates it and affects Task Studio identically — a shared architectural bug, not a
 * regression from t-cdd4e1.
 *
 * Fix: `resetEditorFrom` stashes the loaded entity in a `pendingEditorEntity` ref instead of creating
 * the editor inline; a separate effect with no dependency array (runs after every commit, cheap no-op
 * once nothing is pending) creates it once `mount.current` is actually populated.
 */
describe("rich-doc editor mount race stays fixed (t-112627)", () => {
  for (const file of ["packages/webview-ui/src/webview/pin-studio/App.tsx", "packages/webview-ui/src/webview/task-studio/App.tsx"]) {
    it(`${file}: resetEditorFrom defers editor creation to a post-commit effect instead of running it inline`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("pendingEditorEntity");

      // resetEditorFrom itself must NOT call createRichDocEditor directly — only stash the entity.
      const resetStart = src.indexOf("const resetEditorFrom = ");
      expect(resetStart).toBeGreaterThan(-1);
      const resetEnd = src.indexOf("\n  };", resetStart);
      expect(resetEnd).toBeGreaterThan(resetStart);
      const resetBody = src.slice(resetStart, resetEnd);
      expect(resetBody).not.toContain("createRichDocEditor");
      expect(resetBody).toContain("pendingEditorEntity.current = loadedEntity");

      // the mount effect must exist, check mount.current is real before creating, and clear the
      // pending ref so it doesn't recreate the editor on every subsequent render.
      const mountEffectAt = src.indexOf("pendingEditorEntity.current;");
      expect(mountEffectAt).toBeGreaterThan(-1);
      const mountEffectRegion = src.slice(mountEffectAt, mountEffectAt + 800);
      expect(mountEffectRegion).toMatch(/if \(!loadedEntity \|\| !mount\.current\) return;/);
      expect(mountEffectRegion).toContain("pendingEditorEntity.current = null;");
      expect(mountEffectRegion).toContain("createRichDocEditor(");

      // the rebind-reset effect (fresh mount / same-route re-entry) must clear any stale pending
      // entity from a PREVIOUS binding, or a slow-arriving mount could create an editor from data
      // belonging to a binding that's already been torn down.
      const rebindAt = src.indexOf("hasLoadedRef.current = false;");
      expect(rebindAt).toBeGreaterThan(-1);
      const rebindRegion = src.slice(rebindAt, rebindAt + 400);
      expect(rebindRegion).toContain("pendingEditorEntity.current = null;");
    });
  }
});
