import { describe, expect, it } from "vitest";
import path from "node:path";
import { h } from "preact";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { InspectorModel } from "@tachyon/webview-ui/inspector/model";
import type { InspectorScope, InspectorStrings } from "../../packages/webview-ui/src/webview/inspector/messages.js";

/**
 * t-6b5dea — the tmux app opens on the project the SIDEBAR selected, and no session becomes unreachable.
 *
 * Those are the task's two halves and they pull against each other, which is why they are proven in one
 * file: a delivery that only scoped the screen would pass the first and lose the closed-folder and
 * other-window sessions — the rows someone opens tmux to find precisely when something went wrong, and
 * the ones a selector over ATTACHED projects cannot name.
 *
 * Measured through the real component with the real props the host pushes (`init` carries the scope), not
 * through the manager's internals. The static renderer has no state transitions, so it witnesses the
 * FIRST PAINT — which is exactly what "opens already filtered" means — and the precedence rule a click
 * exercises is asserted on `effectiveWorkspace`, the pure function the component defers to.
 */
const APP = path.resolve(__dirname, "../../packages/webview-ui/src/webview/inspector/App.tsx");

const scope: InspectorScope = { hash: "a1b2c3d4", label: "tachyon" };

/** two attached projects and one closed folder — the universe the task says is wider than the sidebar's. */
const model: InspectorModel = {
  totalSessions: 3,
  liveSessions: 3,
  deadSessions: 0,
  orphanSessions: 1,
  busySessions: 0,
  groups: [
    {
      wsHash: "a1b2c3d4",
      workspace: "tachyon",
      foreign: false,
      sessions: [{ session: "tachyon-a1b2c3d4-build", kind: "session", label: "SCOPED-ROW", pid: 1, dead: false, currentCommand: "bash", startCommand: "bash" }],
    },
    {
      wsHash: "d4e5f6a7",
      workspace: "other-project",
      foreign: false,
      sessions: [{ session: "tachyon-d4e5f6a7-writer", kind: "session", label: "OTHER-PROJECT-ROW", pid: 2, dead: false, currentCommand: "bash", startCommand: "bash" }],
    },
    {
      wsHash: "ff009911",
      workspace: "(closed / other workspace)",
      foreign: true,
      sessions: [{ session: "tachyon-ff009911-old", kind: "session", label: "ORPHAN-ROW", pid: 3, dead: false, currentCommand: "bash", startCommand: "bash" }],
    },
  ],
};

/** the l10n strings the host posts; only the ones this file reads carry recognisable text. */
const strings = new Proxy({} as InspectorStrings, {
  get: (_t, name) =>
    ({
      scopeNote: "Showing {0} — {1} hidden",
      scopeShowAll: "SHOW-EVERY-SESSION",
      workspace: "Workspace",
      all: "All",
    }[String(name)] ?? String(name)),
});

interface AppModule {
  App: (props: Record<string, unknown>) => unknown;
  effectiveWorkspace: (chosen: string | undefined, scope: InspectorScope | undefined) => string;
}

const paint = (mod: AppModule, over: Record<string, unknown> = {}): string =>
  renderStatic(
    h(mod.App as never, {
      model,
      strings,
      captures: {},
      open: new Set<string>(),
      auto: true,
      onToggleAuto: () => {},
      onToggleCapture: () => {},
      onCloseCapture: () => {},
      onAction: () => {},
      ...over,
    } as never),
  );

describe("t-6b5dea — the tmux app opens on the sidebar's project", () => {
  it("paints only that project's sessions, without being asked", async () => {
    const mod = (await loadWebviewModule(APP)) as unknown as AppModule;
    const html = paint(mod, { scope });

    expect(html).toContain("SCOPED-ROW");
    expect(html).not.toContain("OTHER-PROJECT-ROW");
    expect(html).not.toContain("ORPHAN-ROW");
  });

  it("says so on screen, counts what it is holding back, and carries the way out", async () => {
    const mod = (await loadWebviewModule(APP)) as unknown as AppModule;
    const html = paint(mod, { scope });

    // the disclosure names the project and the number — a default nobody chose may not be silent
    expect(html).toContain("Showing tachyon — 2 hidden");
    // …and the escape is a control ON the screen, not only a row in the dropdown
    expect(html).toContain("SHOW-EVERY-SESSION");
  });

  it("still NAMES the orphan group in the Workspace filter — the row is hidden, never unreachable", async () => {
    const mod = (await loadWebviewModule(APP)) as unknown as AppModule;
    const html = paint(mod, { scope });

    // The options are built from the whole model, not from the filtered groups: the closed folder and the
    // other project are both selectable while the screen shows neither. This is the guard's second half —
    // the sidebar's selector knows only attached projects, so the filter has to outlive it.
    expect(html).toContain('<option value="ff009911">(closed / other workspace)</option>');
    expect(html).toContain('<option value="d4e5f6a7">other-project</option>');
    expect(html).toContain('<option value="all">');
  });

  it("shows everything, and no note, when no project is selected", async () => {
    const mod = (await loadWebviewModule(APP)) as unknown as AppModule;
    const html = paint(mod, {});

    expect(html).toContain("SCOPED-ROW");
    expect(html).toContain("OTHER-PROJECT-ROW");
    expect(html).toContain("ORPHAN-ROW");
    expect(html).not.toContain("SHOW-EVERY-SESSION");
  });

  it("names a scoped project that owns no session, instead of selecting a blank row", async () => {
    const mod = (await loadWebviewModule(APP)) as unknown as AppModule;
    const html = paint(mod, { scope: { hash: "99999999", label: "quiet-project" } });

    // the <select>'s value has to match an option or the browser shows the first one as chosen — and this
    // is the case where the human MUST notice, since the list below is empty while sessions exist.
    expect(html).toContain('<option value="99999999">quiet-project</option>');
    expect(html).toContain("Showing quiet-project — 3 hidden");
    expect(html).not.toContain("ORPHAN-ROW");
  });

  it("a human's pick beats the window scope — including when the pick is 'all'", async () => {
    const mod = (await loadWebviewModule(APP)) as unknown as AppModule;

    // the case a 3s refresh would otherwise undo: someone asked for everything, and a scope push arrives
    expect(mod.effectiveWorkspace("all", scope)).toBe("all");
    expect(mod.effectiveWorkspace("ff009911", scope)).toBe("ff009911");
    // …and with no pick the sidebar decides, or nothing does
    expect(mod.effectiveWorkspace(undefined, scope)).toBe("a1b2c3d4");
    expect(mod.effectiveWorkspace(undefined, undefined)).toBe("all");
  });
});
