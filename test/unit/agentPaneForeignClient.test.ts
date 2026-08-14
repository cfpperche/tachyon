import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { AgentPanePanelManager } from "../../apps/vscode-extension/src/webview/AgentPanePanel.js";
import { SessionViewportRegistry } from "../../apps/vscode-extension/src/presentation/sessionViewport.js";
import type { PtyProcess, PtySpawn } from "../../apps/vscode-extension/src/presentation/TmuxAttachClient.js";
import { __createdPanels, __resetVscodeMock, __setPanelVisible, Uri } from "../mocks/vscode.js";

/**
 * t-edbe36 — behavioural guard through the real Agent Pane host.
 *
 * When the pane holds the session and `list-clients` measures a second client of a different
 * size, the host must surface a co-attach notice (identity status + co-attach message). It must
 * NOT try to drop that client, and it must clear the notice when the second client is gone.
 *
 * Fail-before: before the host wires listClients → probe → postMessage, these assertions fail.
 */

const SESSION = "tachyon-ws-claude";

function fakePtyFactory(): { spawn: PtySpawn; spawned: PtyProcess[] } {
  const spawned: PtyProcess[] = [];
  const spawn: PtySpawn = () => {
    const proc: PtyProcess = {
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {},
    };
    spawned.push(proc);
    return proc;
  };
  return { spawn, spawned };
}

async function openPane(opts: {
  viewports: SessionViewportRegistry;
  ptySpawn: PtySpawn;
  listClients?: (session: string) => Promise<Array<{ name: string; width: number; height: number }>>;
}) {
  const manager = new AgentPanePanelManager(new Uri("/ext") as unknown as vscode.Uri, opts.viewports);
  await manager.open({
    agent: "claude",
    session: SESSION,
    resizeSession: async () => {},
    deliverText: async () => {},
    openTemplateInject: async () => false,
    createPinFromSelection: async () => ({ id: "pin-1" }),
    ptySpawn: opts.ptySpawn,
    ...(opts.listClients ? { listClients: opts.listClients } : {}),
  });
  const panel = __createdPanels.at(-1)!;
  panel.webview.__receive({ type: "agent-pane/ready" });
  panel.webview.__receive({ type: "agent-pane/resize", cols: 220, rows: 50 });
  // Let the post-attach foreign-client probe settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { manager, panel };
}

const coAttach = (panel: { webview: { posted: unknown[] } }) =>
  panel.webview.posted.filter(
    (m): m is { type: string; present: boolean; width?: number; height?: number } =>
      !!m && typeof m === "object" && (m as { type?: unknown }).type === "agent-pane/co-attach",
  );

const statuses = (panel: { webview: { posted: unknown[] } }) =>
  panel.webview.posted
    .filter(
      (m): m is { type: string; status: string } =>
        !!m && typeof m === "object" && (m as { type?: unknown }).type === "agent-pane/status",
    )
    .map((m) => m.status);

describe("agent pane foreign tmux client (t-edbe36)", () => {
  beforeEach(() => {
    __resetVscodeMock();
  });

  it("surfaces a temporary safe notice when list-clients measures a smaller peer", async () => {
    const viewports = new SessionViewportRegistry();
    const { spawn } = fakePtyFactory();
    let clients = [
      { name: "/dev/pts/12", width: 220, height: 50 },
      { name: "/dev/pts/3", width: 80, height: 24 },
    ];
    const { panel } = await openPane({
      viewports,
      ptySpawn: spawn,
      listClients: async () => clients,
    });

    expect(viewports.ownerOf(SESSION)).toBe("pane");
    const notice = coAttach(panel).at(-1);
    expect(notice).toMatchObject({ present: true, width: 80, height: 24 });
    const status = statuses(panel).at(-1) ?? "";
    expect(status.toLowerCase()).toMatch(/another tmux client/);
    expect(status.toLowerCase()).toMatch(/temporary/);
    expect(status.toLowerCase()).toMatch(/safe/);

    // Foreign client left — notice clears, status returns to attached.
    clients = [{ name: "/dev/pts/12", width: 220, height: 50 }];
    panel.webview.__receive({ type: "agent-pane/resize", cols: 220, rows: 50 });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(coAttach(panel).at(-1)).toMatchObject({ present: false });
    expect(statuses(panel).at(-1)).toBe("attached");
  });

  it("stays quiet when only one client is measured", async () => {
    const viewports = new SessionViewportRegistry();
    const { spawn } = fakePtyFactory();
    const { panel } = await openPane({
      viewports,
      ptySpawn: spawn,
      listClients: async () => [{ name: "/dev/pts/12", width: 220, height: 50 }],
    });
    expect(coAttach(panel).some((m) => m.present)).toBe(false);
  });

  it("never calls a detach/kill path — only listClients is consulted", async () => {
    const viewports = new SessionViewportRegistry();
    const { spawn, spawned } = fakePtyFactory();
    const seen: string[] = [];
    const { panel } = await openPane({
      viewports,
      ptySpawn: spawn,
      listClients: async (session) => {
        seen.push(session);
        return [
          { name: "us", width: 220, height: 50 },
          { name: "them", width: 80, height: 24 },
        ];
      },
    });
    expect(seen).toContain(SESSION);
    // Our single PTY client is still alive; we did not dispose it to "fix" the foreign one.
    expect(spawned).toHaveLength(1);
    expect(viewports.ownerOf(SESSION)).toBe("pane");
    expect(coAttach(panel).at(-1)?.present).toBe(true);
  });
});

/**
 * SDD 485 B1 — the pane's only periodic WORK is this poll, and it exists to explain something on
 * screen. Behind another tab there is nothing to explain, so it stops entirely: the timer is cleared,
 * not merely short-circuited inside its callback.
 *
 * The catch-up has no delta branch and needs none. `list-clients` reads the CURRENT client list, so
 * one probe on reveal IS a full resync — what was suppressed is the notice about a state, and the
 * state is re-derived rather than replayed. Contrast Control, where the suppressed thing is an
 * invalidation whose subject is gone by the time anyone looks.
 *
 * Counted in list-clients calls, never in elapsed time.
 */
describe("agent pane co-attach poll stops behind another tab (SDD 485 B1)", () => {
  beforeEach(() => {
    __resetVscodeMock();
  });

  async function pollingPane() {
    const viewports = new SessionViewportRegistry();
    const { spawn } = fakePtyFactory();
    let calls = 0;
    const { manager, panel } = await openPane({
      viewports,
      ptySpawn: spawn,
      listClients: async () => {
        calls += 1;
        return [{ name: "/dev/pts/12", width: 220, height: 50 }];
      },
    });
    return { manager, panel, viewports, calls: () => calls };
  }

  /** Four poll windows' worth of ticks (2s each), drained without waiting for any of them. */
  async function tick(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  it("runs no list-clients at all while hidden, then re-probes once on reveal", async () => {
    const { panel, calls } = await pollingPane();
    vi.useFakeTimers();
    try {
      __setPanelVisible(panel, false);
      const atHide = calls();

      await tick(4);
      expect(calls()).toBe(atHide); // eight seconds of hidden pane: zero tmux calls

      __setPanelVisible(panel, true);
      await Promise.resolve();
      await Promise.resolve();
      expect(calls()).toBe(atHide + 1); // one immediate probe — the catch-up

      await tick(1);
      expect(calls()).toBe(atHide + 2); // and the poll is live again
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resurrect the poll on reveal after the session was handed off", async () => {
    // The pane detached deliberately (t-feaaea): reattach is a human decision, and a reveal is not
    // one. This is why hiding CLEARS THE TIMER but leaves the intent alone, instead of collapsing
    // the two into one flag — a reveal that restarted the poll here would be measuring a session
    // the integrated terminal now owns.
    const { panel, viewports, calls } = await pollingPane();
    viewports.claim(SESSION, "terminal", () => {}); // the terminal takes it → pane releases
    await Promise.resolve();
    expect(viewports.ownerOf(SESSION)).toBe("terminal");

    vi.useFakeTimers();
    try {
      __setPanelVisible(panel, false);
      __setPanelVisible(panel, true);
      const afterReveal = calls();
      await tick(2);

      expect(calls()).toBe(afterReveal);
    } finally {
      vi.useRealTimers();
    }
  });
});
