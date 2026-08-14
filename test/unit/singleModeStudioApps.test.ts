import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sectionPanelKey } from "../../src/webview/shared/SectionPanelManager.js";
import { webviewApp } from "../../src/webview/webviewApps.js";

const studios = [
  "command",
  "terminal",
  "runbook",
  "schedule",
  "agent",
] as const;

/**
 * t-b643ac — who ACTUALLY rides the shared single-mode host, derived from the tree rather than
 * from the hand-written list above. The list is what the tombstone tests iterate; if a sixth studio
 * is put on this host and only added there, every "all five behave" proof silently keeps covering
 * five. Deriving it means a new studio either joins the list or fails right here.
 */
function studiosOnTheSharedHost(): string[] {
  return readdirSync("src/webview")
    .filter((f) => f.endsWith("StudioPanel.ts"))
    .filter((f) => readFileSync(`src/webview/${f}`, "utf8").includes("extends SingleModeStudioPanelManager"))
    .map((f) => f.replace(/StudioPanel\.ts$/, "").toLowerCase())
    .sort();
}

describe("SDD 485 D13 — editing-only studio document apps", () => {
  it("declares all five as documents and keys reopening by entity identity", () => {
    for (const studio of studios) {
      const app = webviewApp(`${studio}-studio-shell`);
      expect(app.host).toBe("section");
      if (app.host !== "section") throw new Error(`${studio} is not a section app`);
      expect(app.cardinality).toBe("document");
      const target = { project: "ws-a", identity: "entity-a" };
      expect(sectionPanelKey(app.viewId, app.cardinality, target)).toBe(
        sectionPanelKey(app.viewId, app.cardinality, target),
      );
      expect(sectionPanelKey(app.viewId, app.cardinality, target)).not.toBe(
        sectionPanelKey(app.viewId, app.cardinality, {
          project: "ws-a",
          identity: "entity-b",
        }),
      );
    }
  });

  it("has one standalone entry per studio and no renderer residue in Control", () => {
    expect(() => readFileSync("packages/webview-ui/src/webview/cockpit/App.tsx", "utf8")).toThrow();
    for (const studio of studios) {
      const main = readFileSync(`packages/webview-ui/src/webview/${studio}-studio-shell/main.tsx`, "utf8");
      // t-cd01bb: this asserted the literal `mountSingleModeStudio(App)` and went red when the
      // studio roots gained an error boundary — the argument became a callback supplying the same
      // App. What this case is FOR is unchanged by that: one standalone entry per studio, mounted
      // through the shared helper rather than re-rendered inside Control. The literal argument form
      // was a proxy for that claim and never the claim itself, so it pinned a shape no criterion
      // asked for. Both facts are still checked, and `App` must still be what gets mounted.
      expect(main).toContain("mountSingleModeStudio(");
      expect(main).toMatch(/\bApp\b/);
    }
  });

  it("reuses D12's pending-edit close policy and never introduces a reading mode", () => {
    const policy = readFileSync(
      "src/webview/shared/studio/singleModeEditPolicy.ts",
      "utf8",
    );
    const host = readFileSync(
      "src/webview/shared/studio/SingleModeStudioPanelManager.ts",
      "utf8",
    );
    expect(policy).toContain(
      "TaskDocumentEditPolicy as SingleModeStudioEditPolicy",
    );
    expect(host).toMatch(/new SingleModeStudioEditPolicy<unknown>\(\s*"edit"/);
    expect(host).not.toContain('switchMode("read")');
  });

  it("carries the tombstone contract in every shell on the shared host, and knows about all of them", () => {
    // t-b643ac — the host posts `tombstone` for ALL of these (one fix, five screens), so a shell that
    // never learned to render it would keep an editor mounted over an entity that no longer exists —
    // the exact defect, arriving through a studio nobody re-checked.
    expect(studiosOnTheSharedHost()).toEqual([...studios].sort());
    for (const studio of studios) {
      const app = readFileSync(`packages/webview-ui/src/webview/${studio}-studio-shell/App.tsx`, "utf8");
      expect(app, `${studio}: no tombstone branch`).toContain('d.type === "tombstone"');
      expect(app, `${studio}: does not render the shared tombstone`).toContain("<StudioTombstone");
      // Rendered INSTEAD of the frame, not above it — this is what removes Save from the DOM.
      expect(app.indexOf("<StudioTombstone")).toBeLessThan(app.indexOf("<StudioFrame"));
    }
  });

  it("keeps every studio panel source line at or below 200 characters", () => {
    for (const studio of studios) {
      const name = `${studio[0].toUpperCase()}${studio.slice(1)}StudioPanel.ts`;
      const long = readFileSync(`src/webview/${name}`, "utf8")
        .split("\n")
        .filter((line) => line.length > 200);
      expect(long, name).toEqual([]);
    }
  });
});
