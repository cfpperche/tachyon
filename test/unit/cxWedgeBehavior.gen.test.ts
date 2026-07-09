import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTmuxExecutor, TMUX_CONTROL_TIMEOUT_MS, TmuxService } from "../../src/tmux/TmuxService.js";

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

describe("container-generated delegation behavior", () => {
  it("no synchronous child_process runs in the bridge/tmux/attention hot path and tmux ops time out with child cancellation", async () => {
    const files = ["src/bridge", "src/tmux", "src/attention", "src/bridge/tools.ts"].flatMap(sourceFiles);
    const offenders = files.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return [...text.matchAll(/\b(?:execSync|execFileSync|spawnSync)\b/g)].map((match) => `${path.relative(repoRoot, file)}:${match.index}`);
    });
    expect(offenders).toEqual([]);

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
});
