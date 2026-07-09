import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTmuxExecutor, TMUX_CONTROL_TIMEOUT_MS, TmuxError, TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";

const repoRoot = path.resolve(__dirname, "../..");

function sourceFiles(target: string): string[] {
  const abs = path.join(repoRoot, target);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return abs.endsWith(".ts") ? [abs] : [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(target, entry.name);
    return entry.isDirectory() ? sourceFiles(child) : child.endsWith(".ts") ? [path.join(repoRoot, child)] : [];
  });
}

const SYNC_CHILD_PROCESS_ALLOWLIST: Record<string, string> = {
  // Pre-commit i18n gate entry: invoked by git hooks in a separate process with no VS Code running.
  "src/plugins/i18nPtbrGate.ts": "separate git-hook process",
  // External-tool resolver/probe module: used by explicit plugin install/rehydrate flows and the standalone `_tachyon-external` shim, not Bridge/tmux MCP handlers.
  "src/plugins/externalTool.ts": "plugin external-tool resolver/provisioning path",
  // Tool provisioning module: used by explicit plugin install/rehydrate flows and launcher-adjacent smoke checks, not Bridge/tmux MCP handlers.
  "src/plugins/toolProvisioning.ts": "plugin tool provisioning path",
  // Tool launcher entry: copied to .tachyon/bin and run by hooks/agents as its own process with no VS Code running.
  "src/plugins/toolLauncher.ts": "separate tool-launch process",
  // Tool platform probes: used by data/tool resolver entry processes before extension-host participation.
  "src/plugins/toolPlatform.ts": "separate resolver process",
};

function syncChildProcessOffenders(textOverrides: Record<string, string> = {}): string[] {
  const files = sourceFiles("src");
  return files.flatMap((file) => {
    const rel = path.relative(repoRoot, file).split(path.sep).join(path.posix.sep);
    if (rel in SYNC_CHILD_PROCESS_ALLOWLIST) return [];
    const text = textOverrides[rel] ?? fs.readFileSync(file, "utf8");
    return [...text.matchAll(/\b(?:execSync|execFileSync|spawnSync)\b/g)].map((match) => `${rel}:${match.index}`);
  });
}

describe("container-generated delegation behavior", () => {
  it("no synchronous child_process runs under src except documented separate-process entry points, and tmux ops time out with child cancellation", async () => {
    expect(Object.values(SYNC_CHILD_PROCESS_ALLOWLIST).every((reason) => reason.length > 0)).toBe(true);
    expect(syncChildProcessOffenders()).toEqual([]);
    expect(
      syncChildProcessOffenders({
        "src/agents/AgentManager.ts": `${fs.readFileSync(path.join(repoRoot, "src/agents/AgentManager.ts"), "utf8")}\nspawnSync("git", ["status"]);\n`,
      }),
    ).toEqual([expect.stringMatching(/^src\/agents\/AgentManager\.ts:/)]);

    vi.useFakeTimers();
    const kill = vi.fn();
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() },
      kill,
    });
    const execFile = vi.fn((_file, _args, _opts, _cb) => fakeChild);
    const tmux = new TmuxService(createTmuxExecutor(execFile as never), "wedge-test");

    const pending = expect(tmux.killSession("tachyon-test")).rejects.toThrow(/kill-session timed out.*wedge-test/);
    await vi.advanceTimersByTimeAsync(TMUX_CONTROL_TIMEOUT_MS);
    await pending;
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    vi.useRealTimers();
  });

  it("reconciles a new-session timeout that landed server-side before surfacing a clear error", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      calls.push(args);
      if (args.includes("new-session")) throw new TmuxError("tmux new-session timed out after 8000ms", args);
      return { stdout: "", stderr: "" };
    };
    const tmux = new TmuxService(exec, "wedge-test");

    await expect(tmux.newSession({ name: "tachyon-x-late", cmd: "sleep 1" })).rejects.toThrow(
      /session 'tachyon-x-late' was created.*cleaned it up/,
    );
    expect(calls.some((args) => args.includes("has-session") && args.includes("=tachyon-x-late"))).toBe(true);
    expect(calls.some((args) => args.includes("kill-session") && args.includes("=tachyon-x-late"))).toBe(true);
  });
});
