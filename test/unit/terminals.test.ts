import { describe, it, expect, beforeEach } from "vitest";
import { attachSocketPath, Terminals, type TerminalRestoreEntry } from "../../apps/vscode-extension/src/presentation/Terminals.js";
import { __createdTerminals, __resetVscodeMock, ViewColumn } from "../mocks/vscode.js";

describe("attachSocketPath", () => {
  it("prefers an existing engine socket over an empty Dev Host private TMUX_TMPDIR", () => {
    const path = attachSocketPath(
      { TMUX_TMPDIR: "/private/dev-host/tmux" },
      // Only the default /tmp socket exists (engine); private Dev Host socket does not.
      (p) => /^\/tmp\/tmux-\d+\/tachyon$/.test(p),
    );
    expect(path).toMatch(/^\/tmp\/tmux-\d+\/tachyon$/);
  });

  it("uses TACHYON_ENGINE_TMUX_TMPDIR when that socket exists", () => {
    const path = attachSocketPath(
      { TMUX_TMPDIR: "/private/dev-host/tmux", TACHYON_ENGINE_TMUX_TMPDIR: "/engine/tmp" },
      (p) => p.includes("/engine/tmp/"),
    );
    expect(path).toMatch(/\/engine\/tmp\/tmux-\d+\/tachyon$/);
  });
});

describe("Terminals restore manifest", () => {
  beforeEach(() => {
    __resetVscodeMock();
  });

  it("does not prune valid entries when tmux liveness is temporarily false or throws", async () => {
    let manifest: unknown = [
      { schemaVersion: 1, agent: "claude", session: "tachyon-ws-claude" },
      { schemaVersion: 1, agent: "codex", session: "tachyon-ws-codex" },
    ] satisfies TerminalRestoreEntry[];
    const writes: TerminalRestoreEntry[][] = [];
    const terminals = new Terminals(undefined, undefined, {
      read: () => manifest,
      write: (entries) => {
        writes.push(entries);
        manifest = entries;
      },
    });

    await terminals.restoreOpen(async (session) => {
      if (session.includes("codex")) throw new Error("tmux not ready");
      return false;
    });

    expect(__createdTerminals).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(manifest).toEqual([
      { schemaVersion: 1, agent: "claude", session: "tachyon-ws-claude" },
      { schemaVersion: 1, agent: "codex", session: "tachyon-ws-codex" },
    ]);
  });

  it("reopens only live sessions while keeping skipped valid entries in the manifest", async () => {
    let manifest: unknown = [
      { schemaVersion: 1, agent: "claude", session: "tachyon-ws-claude", viewColumn: ViewColumn.Two, title: "Claude" },
      { schemaVersion: 1, agent: "codex", session: "tachyon-ws-codex" },
      { schemaVersion: 1, agent: "broken", session: 123 },
    ];
    const writes: TerminalRestoreEntry[][] = [];
    const terminals = new Terminals(undefined, (agent) => (agent === "codex" ? "terminal" : "agent"), {
      read: () => manifest,
      write: (entries) => {
        writes.push(entries);
        manifest = entries;
      },
    });

    await terminals.restoreOpen(async (session) => session.endsWith("-claude"));

    expect(__createdTerminals).toHaveLength(1);
    expect(__createdTerminals[0].options).toMatchObject({
      name: "Claude",
      location: { viewColumn: ViewColumn.Two, preserveFocus: true },
      shellPath: "tmux",
      isTransient: true,
    });
    // Absolute -S socket (not -L) so Dev Host private TMUX_TMPDIR cannot miss the engine server.
    expect(__createdTerminals[0].options.shellArgs?.[0]).toBe("-u");
    expect(__createdTerminals[0].options.shellArgs?.[1]).toBe("-S");
    expect(__createdTerminals[0].options.shellArgs?.[2]).toMatch(/\/tmux-\d+\/tachyon$/);
    expect(__createdTerminals[0].options.shellArgs?.slice(3)).toEqual(["attach-session", "-d", "-t", "=tachyon-ws-claude"]);
    expect(__createdTerminals[0].showCalls).toEqual([true]);
    expect(manifest).toEqual([
      { schemaVersion: 1, agent: "claude", session: "tachyon-ws-claude", viewColumn: ViewColumn.Two, title: "Claude" },
      { schemaVersion: 1, agent: "codex", session: "tachyon-ws-codex" },
    ]);
    expect(writes.at(-1)).toEqual(manifest);
  });

  it("keeps same-named agents from different workspaces isolated by tmux session", () => {
    const terminals = new Terminals();
    const first = terminals.open("codex", "tachyon-workspace-a-codex");
    const second = terminals.open("codex", "tachyon-workspace-b-codex");

    expect(__createdTerminals).toHaveLength(2);
    expect(first).not.toBe(second);
    terminals.close("codex", "tachyon-workspace-a-codex");
    expect(__createdTerminals[0].disposed).toBe(true);
    expect(__createdTerminals[1].disposed).toBe(false);
    expect(terminals.has("codex")).toBe(true);
    terminals.close("codex");
    expect(__createdTerminals[1].disposed).toBe(true);
    expect(terminals.has("codex")).toBe(false);
  });

  it("reports a manually closed tab with its exact agent and session", () => {
    const closed: Array<{ agent: string; session: string }> = [];
    const terminals = new Terminals(undefined, undefined, undefined, (agent, session) => {
      closed.push({ agent, session });
    });
    const terminal = terminals.open("codex", "tachyon-workspace-a-codex");

    terminal.dispose();

    expect(closed).toEqual([{ agent: "codex", session: "tachyon-workspace-a-codex" }]);
  });

  it("does not echo an engine-requested close back as a manual close", () => {
    const closed: string[] = [];
    const terminals = new Terminals(undefined, undefined, undefined, (_agent, session) => closed.push(session));
    terminals.open("codex", "tachyon-workspace-a-codex");

    terminals.close("codex", "tachyon-workspace-a-codex");

    expect(closed).toEqual([]);
  });
});
