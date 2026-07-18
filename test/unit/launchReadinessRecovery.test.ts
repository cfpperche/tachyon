import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import {
  CodexLaunchReadiness,
  matchCodexBootstrapInput,
} from "../../src/runtime/adapters/codexLaunchReadiness.js";
import { GenericLaunchReadiness, LaunchReadiness } from "../../src/runtime/launchReadiness.js";

describe("CodexLaunchReadiness", () => {
  it("rejects an unclassified runtime that exits during the bounded window", async () => {
    let now = 0;
    const readiness = new LaunchReadiness({ windowMs: 100, pollMs: 10, now: () => now, sleep: async (ms) => { now += ms; } });
    await expect(readiness.wait({
      capture: async () => "starting",
      adapter: new GenericLaunchReadiness(),
      isAlive: async () => false,
      aliveAtDeadline: "pending",
    })).resolves.toEqual({ state: "rejected", code: "runtime_process_exited" });
  });

  it("promotes only a recognized runtime composer and otherwise remains pending", async () => {
    const adapter = new GenericLaunchReadiness({ tailLines: 2, promptLine: /^>\s?.*$/ });
    expect(adapter.classify("startup\n> ")).toEqual({ state: "ready" });
    expect(adapter.classify("startup\nstill loading")).toBeUndefined();

    let now = 0;
    const readiness = new LaunchReadiness({ windowMs: 20, pollMs: 10, now: () => now, sleep: async (ms) => { now += ms; } });
    await expect(readiness.wait({
      capture: async () => "still loading",
      adapter,
      isAlive: async () => true,
      aliveAtDeadline: "pending",
    })).resolves.toEqual({ state: "pending" });
  });

  it("SDD 402: recognizes Pi's complete framed editor but not trust/modal or arbitrary frames", () => {
    const frame = "─".repeat(80);
    const adapter = new GenericLaunchReadiness({
      tailLines: 16,
      frameLine: /^─{10,}\s*$/,
      readyLine: /^\s*\d+(?:\.\d+)?%\/\S+.*\S+\s*$/,
    });
    expect(adapter.classify([frame, " ", frame, "~/repo (main)", "0.0%/4.1k (auto) measure"].join("\n"))).toEqual({ state: "ready" });
    expect(adapter.classify([frame, "Trust project folder?", "→ Trust", frame].join("\n"))).toBeUndefined();
    expect(adapter.classify([frame, "arbitrary output", frame, "not a footer"].join("\n"))).toBeUndefined();
    expect(adapter.classify([frame, "draft", "0.0%/4.1k (auto) measure"].join("\n"))).toBeUndefined();
  });

  it("t-40a28c: recognizes the rotating composer plus stable footer used by Codex 0.144.1", () => {
    const adapter = new CodexLaunchReadiness();
    const pane = [
      "• Working (1m 11s • esc to interrupt)",
      "",
      "› Implement {feature}",
      "",
      "  gpt-5.6-sol xhigh · ~/tachyon · main · Full Access · Context 61% used · weekly 71% left",
    ].join("\n");

    expect(adapter.classify(pane)).toEqual({ state: "ready" });
  });

  it("does not accept a transcript prompt or footer alone, and rejection still wins", () => {
    const adapter = new CodexLaunchReadiness();
    expect(adapter.classify("› Implement {feature}\n• Booting MCP server")).toBeUndefined();
    expect(adapter.classify("gpt-5.6-sol · Context 0% used")).toBeUndefined();
    expect(adapter.classify("› Implement {feature}\nContext 0% used\nAuthentication failed")).toEqual({
      state: "rejected",
      code: "runtime_auth_rejected",
    });
  });

  it("recognizes the prompt plus a structurally truncated narrow-pane footer", () => {
    const adapter = new CodexLaunchReadiness();
    expect(adapter.classify([
      "› Use /skills to list available skills",
      "",
      "  gpt-5.6-terra default · /tmp/fixture/workspace",
    ].join("\n"))).toEqual({ state: "ready" });
    expect(adapter.classify("› transcript text\n  not-a-footer default words")).toBeUndefined();
    expect(adapter.classify("› transcript text\n  status default · ready")).toBeUndefined();
  });
});

describe("Codex bounded bootstrap input", () => {
  it("matches measured line-oriented screens and refuses unsafe or mismatched answers", () => {
    const terminal = 'WARNING: TERM is set to "dumb". Continue anyway? [y/N]:';
    expect(matchCodexBootstrapInput(terminal, "y", true)).toEqual({ kind: "terminal-warning", delivery: "submitted-line" });
    expect(matchCodexBootstrapInput(terminal, "FIRST CONTRACT", true)).toBeUndefined();
    expect(matchCodexBootstrapInput(terminal, "y", false)).toBeUndefined();

    const update = [
      "✨ Update available! 0.144.1 -> 0.144.3",
      "› 1. Update now (runs npm install)",
      "  2. Skip",
      "  3. Skip until next version",
      "  Press enter to continue",
    ].join("\n");
    expect(matchCodexBootstrapInput(update, "1", true)).toBeUndefined();
    expect(matchCodexBootstrapInput(update, "3", true)).toEqual({ kind: "update-notice", delivery: "submitted-line" });
    expect(matchCodexBootstrapInput(`${update}\nUnrelated current prompt`, "3", true)).toBeUndefined();

    const trust = [
      "Do you trust the contents of this directory?",
      "Trusting the directory allows project-local config, hooks, and exec policies to load.",
      "› 1. Yes, continue",
      "  2. No, quit",
      "  Press enter to continue",
    ].join("\n");
    expect(matchCodexBootstrapInput(trust, "1", true)).toEqual({ kind: "directory-trust", delivery: "submitted-line" });
    expect(matchCodexBootstrapInput(trust, "t", false)).toBeUndefined();
    expect(matchCodexBootstrapInput(`${trust}\nUnrelated current prompt`, "1", true)).toBeUndefined();
  });

  it("supports only measured hook-review key gestures, including the safe escape path", () => {
    const overview = [
      "Hooks",
      "Lifecycle hooks from config and enabled plugins.",
      "⚠ 1 hook needs review before it can run.",
      "Press t to trust all; enter to review hooks; esc to close",
    ].join("\n");
    expect(matchCodexBootstrapInput(overview, "", true)).toEqual({ kind: "hooks-overview", delivery: "submitted-line" });
    expect(matchCodexBootstrapInput(overview, "t", false)).toEqual({ kind: "hooks-overview", delivery: "literal-key" });
    expect(matchCodexBootstrapInput(overview, "\u001b", false)).toEqual({ kind: "hooks-overview", delivery: "literal-key" });
    expect(matchCodexBootstrapInput(overview, "t", true)).toBeUndefined();
    expect(matchCodexBootstrapInput(`${overview}\nUnrelated current prompt`, "\u001b", false)).toBeUndefined();

    const review = [
      "SessionStart hooks",
      "1 hook needs review before it can run.",
      "Press t to trust; esc to go back",
    ].join("\n");
    expect(matchCodexBootstrapInput(review, "\u001b", false)).toEqual({ kind: "hook-review", delivery: "literal-key" });
    expect(matchCodexBootstrapInput(review, "FIRST CONTRACT", true)).toBeUndefined();
  });
});

describe("Codex readiness recovery", () => {
  it("re-observes a declared live Codex session after manager memory is lost", async () => {
    const sessions = new Set(["tachyon-test-codex"]);
    let pane = "Starting Codex";
    let killed = false;
    const tmux = {
      hasSession: async (name: string) => sessions.has(name),
      capturePane: async () => pane,
      killSession: async (name: string) => { killed = sessions.delete(name); },
    };
    const manager = new AgentManager({
      tmux: tmux as never,
      workspaceRoot: "/workspace",
      wsHash: "test",
      getConfig: () => ({
        agents: { codex: { cmd: "codex", kind: "agent" } },
        settings: { maxAgents: 4 },
        declaredOwner: {},
      }) as never,
      getMaxAgents: () => 4,
    });

    await expect(manager.isReady("codex")).resolves.toBe(false);
    pane = "› Implement {feature}\n\n  gpt-5.6-sol xhigh · Context 61% used";
    await expect(manager.isReady("codex")).resolves.toBe(true);
    pane = "Authentication failed";
    const restartedManager = new AgentManager({
      tmux: tmux as never,
      workspaceRoot: "/workspace",
      wsHash: "test",
      getConfig: () => ({ agents: { codex: { cmd: "codex", kind: "agent" } }, settings: { maxAgents: 4 }, declaredOwner: {} }) as never,
      getMaxAgents: () => 4,
    });
    await expect(restartedManager.isReady("codex")).resolves.toBe(false);
    expect(killed).toBe(true);
  });

  it("does not gate unknown, non-Codex, or non-running declared agents", async () => {
    const manager = new AgentManager({
      tmux: { hasSession: async () => false } as never,
      workspaceRoot: "/workspace",
      wsHash: "test",
      getConfig: () => ({
        agents: {
          claude: { cmd: "claude", kind: "agent" },
          stoppedCodex: { cmd: "codex", kind: "agent" },
        },
        settings: { maxAgents: 4 },
        declaredOwner: {},
      }) as never,
      getMaxAgents: () => 4,
    });

    await expect(manager.isReady("unknown")).resolves.toBe(true);
    await expect(manager.isReady("claude")).resolves.toBe(true);
    await expect(manager.isReady("stoppedCodex")).resolves.toBe(true);
  });
});
