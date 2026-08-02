import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { AgentPanePanelManager } from "../../src/webview/AgentPanePanel.js";
import { SessionViewportRegistry } from "../../src/presentation/sessionViewport.js";
import type { PtyProcess, PtySpawn } from "../../src/presentation/TmuxAttachClient.js";
import { __createdPanels, __resetVscodeMock, Uri } from "../mocks/vscode.js";

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
