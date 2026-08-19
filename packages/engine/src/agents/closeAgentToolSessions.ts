/**
 * t-ba0d68 — close the tool sessions an agent opened, through the tool's own port.
 *
 * Invoked from agent teardown (worktree removal, kill, dismiss). The agent may already be
 * dead — this does not talk to it. `TACHYON_AGENT_NAME` is set to the dismissed agent so a
 * still-stamping launcher rewrites `--session` to the same name rather than to whoever is
 * running the teardown.
 *
 * Close is best-effort and async so the engine event loop is not blocked. If the
 * launcher is absent, the spawn times out, or the tool exits non-zero, this resolves
 * without throwing so dismiss can still finish. A leftover daemon is preferable to a
 * worktree that can never be removed. We never signal the browser; a timeout only
 * abandons OUR close CLI so teardown is not stuck.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TOOL_SESSION_FLAG, toolSessionNameForAgent } from "./toolSession.js";

export const TOOL_SESSION_CLOSE_TIMEOUT_MS = 8_000;
export const TOOL_SESSION_CLOSE_PLUGIN = "agent-browser";
export const TOOL_SESSION_CLOSE_TOOL = "agent-browser";

export interface ToolSessionChild {
  once(event: "exit" | "error", listener: () => void): unknown;
  unref(): unknown;
}

export type ToolSessionSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ToolSessionChild;

export interface CloseAgentToolSessionsOpts {
  agent: string;
  workspaceRoot: string;
  spawn?: ToolSessionSpawn;
  timeoutMs?: number;
}

export function closeAgentToolSessions(opts: CloseAgentToolSessionsOpts): Promise<void> {
  const agent = opts.agent.trim();
  if (!agent || !opts.workspaceRoot) return Promise.resolve();
  const binDir = path.join(opts.workspaceRoot, ".tachyon", "bin");
  const shim = path.join(binDir, "_tachyon-tool");
  const script = path.join(binDir, "_tachyon-tool.js");
  const session = toolSessionNameForAgent(agent);
  const closeArgv = [TOOL_SESSION_CLOSE_PLUGIN, TOOL_SESSION_CLOSE_TOOL, TOOL_SESSION_FLAG, session, "close"];
  const timeout = opts.timeoutMs ?? TOOL_SESSION_CLOSE_TIMEOUT_MS;
  const env = { ...process.env, TACHYON_AGENT_NAME: agent, AGENT_BROWSER_SESSION: session };
  const run: ToolSessionSpawn = opts.spawn ?? ((cmd, argv, options) => spawn(cmd, [...argv], options) as ToolSessionChild);
  const spawnOpts: SpawnOptions = { env, stdio: "ignore" };
  try {
    if (fs.existsSync(shim)) {
      return waitForClose(run(shim, closeArgv, spawnOpts), timeout);
    }
    if (fs.existsSync(script)) {
      return waitForClose(run(process.execPath, [script, ...closeArgv], spawnOpts), timeout);
    }
  } catch {
    /* missing-binary / spawn failure must not refuse dismiss */
  }
  return Promise.resolve();
}

function waitForClose(child: ToolSessionChild, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // Abandon the close CLI we spawned — not the browser — so dismiss continues.
      try { child.unref(); } catch { /* already exited */ }
      done();
    }, timeoutMs);
    child.once("exit", done);
    child.once("error", done);
  });
}
