import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { AgentPanePanelManager } from "../../apps/vscode-extension/src/webview/AgentPanePanel.js";
import { Terminals } from "../../apps/vscode-extension/src/presentation/Terminals.js";
import { SessionViewportRegistry } from "../../apps/vscode-extension/src/presentation/sessionViewport.js";
import type { PtyProcess, PtySpawn } from "../../apps/vscode-extension/src/presentation/TmuxAttachClient.js";
import { __createdPanels, __createdTerminals, __resetVscodeMock, Uri } from "../mocks/vscode.js";

/**
 * t-feaaea — the reported defect, driven end to end through both viewports.
 *
 * Repro measured on tmux 3.6 with two real clients on one session: while both are attached tmux
 * shrinks the window to the newest client and pads the larger one with `·` (8836 in a single
 * redraw), then `attach-session -d` evicts the older client, which exits {exitCode: 0, signal: 0}
 * while the session keeps running. Layer 1 (`Terminals`) and layer 2 (the Agent Pane) both attach
 * with `-d`, so opening one used to do exactly that to the other.
 *
 * The guard is ORDERING: the outgoing viewport's tmux client must be gone BEFORE the incoming one
 * spawns, because it is the overlap that paints the artifacts and the `-d` that ends the session
 * view. Assertions below therefore check what existed at the moment of each transition, not just
 * the end state.
 */

const SESSION = "tachyon-ws-claude";

interface FakePty extends PtyProcess {
  killed: boolean;
  /** How many integrated terminals existed when this client died — the overlap probe. */
  terminalsAtKill: number;
  emitExit(e: { exitCode: number; signal?: number }): void;
}

function fakePtyFactory(): { spawn: PtySpawn; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  const spawn: PtySpawn = () => {
    let onExit: ((e: { exitCode: number; signal?: number }) => void) | undefined;
    const proc: FakePty = {
      killed: false,
      terminalsAtKill: -1,
      write: () => {},
      resize: () => {},
      kill: () => {
        proc.killed = true;
        proc.terminalsAtKill = __createdTerminals.filter((t) => !t.disposed).length;
      },
      onData: () => {},
      onExit: (cb) => { onExit = cb; },
      emitExit: (e) => onExit?.(e),
    };
    spawned.push(proc);
    return proc;
  };
  return { spawn, spawned };
}

async function openPane(opts: {
  viewports: SessionViewportRegistry;
  ptySpawn: PtySpawn;
  sessionAlive?: (session: string) => Promise<boolean>;
}) {
  // The mock Uri is structural stand-in only — the pane just joins paths onto it.
  const manager = new AgentPanePanelManager(new Uri("/ext") as unknown as vscode.Uri, opts.viewports);
  await manager.open({
    agent: "claude",
    session: SESSION,
    resizeSession: async () => {},
    deliverText: async () => {},
    openTemplateInject: async () => false,
    createPinFromSelection: async () => ({ id: "pin-1" }),
    ptySpawn: opts.ptySpawn,
    ...(opts.sessionAlive ? { sessionAlive: opts.sessionAlive } : {}),
  });
  const panel = __createdPanels.at(-1)!;
  // The webview handshake the real bundle performs: ready, then a measured grid.
  panel.webview.__receive({ type: "agent-pane/ready" });
  panel.webview.__receive({ type: "agent-pane/resize", cols: 120, rows: 40 });
  return { manager, panel };
}

const attachStates = (panel: { webview: { posted: unknown[] } }) =>
  panel.webview.posted.filter(
    (m): m is { type: string; state: string; reason?: string; sessionAlive?: boolean } =>
      !!m && typeof m === "object" && (m as { type?: unknown }).type === "agent-pane/attach-state",
  );

describe("agent pane ↔ integrated terminal share one tmux session (t-feaaea)", () => {
  beforeEach(() => {
    __resetVscodeMock();
  });

  it("releases the pane's tmux client BEFORE the integrated terminal attaches", async () => {
    const viewports = new SessionViewportRegistry();
    const { spawn, spawned } = fakePtyFactory();
    const { panel } = await openPane({ viewports, ptySpawn: spawn });
    expect(spawned).toHaveLength(1);
    expect(viewports.ownerOf(SESSION)).toBe("pane");

    const terminals = new Terminals(undefined, undefined, undefined, undefined, viewports);
    terminals.open("claude", SESSION);

    // The overlap is the defect: no integrated terminal may exist yet when the pane's client dies.
    expect(spawned[0].killed).toBe(true);
    expect(spawned[0].terminalsAtKill).toBe(0);
    expect(__createdTerminals).toHaveLength(1);
    expect(viewports.ownerOf(SESSION)).toBe("terminal");

    // The pane says the session moved, and that the agent is still running — not "attach ended".
    expect(attachStates(panel).at(-1)).toMatchObject({
      state: "detached",
      reason: "handoff",
      sessionAlive: true,
    });
  });

  it("does not re-claim the session on a resize after handing it over", async () => {
    const viewports = new SessionViewportRegistry();
    const { spawn, spawned } = fakePtyFactory();
    const { panel } = await openPane({ viewports, ptySpawn: spawn });
    const terminals = new Terminals(undefined, undefined, undefined, undefined, viewports);
    terminals.open("claude", SESSION);

    // A detached pane is still a live webview: dragging the editor group fires resize events.
    panel.webview.__receive({ type: "agent-pane/resize", cols: 90, rows: 30 });

    expect(spawned).toHaveLength(1); // no second client — reattaching is the human's call
    expect(viewports.ownerOf(SESSION)).toBe("terminal");
    expect(__createdTerminals[0].disposed).toBe(false);
  });

  it("takes the session back on an explicit Reattach, closing the terminal first", async () => {
    const viewports = new SessionViewportRegistry();
    const { spawn, spawned } = fakePtyFactory();
    const { panel } = await openPane({ viewports, ptySpawn: spawn });
    const terminals = new Terminals(undefined, undefined, undefined, undefined, viewports);
    terminals.open("claude", SESSION);

    panel.webview.__receive({ type: "agent-pane/reattach" });

    expect(spawned).toHaveLength(2);
    // Ordering again, from the other side: the terminal is gone before the new client attaches.
    expect(__createdTerminals[0].disposed).toBe(true);
    expect(viewports.ownerOf(SESSION)).toBe("pane");
    expect(attachStates(panel).at(-1)).toMatchObject({ state: "attached" });
  });

  it("tells the human the agent survived when the client dies on its own", async () => {
    const viewports = new SessionViewportRegistry();
    const { spawn, spawned } = fakePtyFactory();
    const { panel } = await openPane({
      viewports,
      ptySpawn: spawn,
      sessionAlive: async () => true,
    });

    // A clean eviction — what a client attaching with -d from outside VS Code produces.
    spawned[0].emitExit({ exitCode: 0, signal: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const exit = panel.webview.posted.find(
      (m): m is { type: string; code: number | null; signal: string | null } =>
        !!m && typeof m === "object" && (m as { type?: unknown }).type === "agent-pane/exit",
    );
    // signal 0 means NO signal; reporting it as one made a clean detach read like a kill.
    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(attachStates(panel).at(-1)).toMatchObject({ state: "detached", reason: "ended", sessionAlive: true });
  });
});
