import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaudeAdapter } from "../../src/probe/adapters/claude.js";
import { createCodexAdapter } from "../../src/probe/adapters/codex.js";
import { ProbeService } from "../../src/probe/ProbeService.js";
import { ProbeStore } from "../../src/probe/ProbeStore.js";

/**
 * Spec 257 (D5) — live capability smoke against the REAL claude/codex CLIs, gated on binary
 * availability (CI safety — skipped when the binary is absent, like tmux.real.test.ts). This is the
 * automated complement to the golden-fixture adapter tests: it proves detectCapability() invokes the
 * actual CLI and records a real version, not a mock. The `--version` probe is offline + free.
 *
 * A real END-TO-END probe (an actual model call — costs money + needs auth) is additionally gated on
 * `PROBE_LIVE_SMOKE=1`, so the default suite never spends money even where the binary exists:
 *   PROBE_LIVE_SMOKE=1 npx vitest run test/unit/probeSmoke.test.ts
 */
function binaryAvailable(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const claudeOk = binaryAvailable("claude");
const codexOk = binaryAvailable("codex");
const liveRun = process.env.PROBE_LIVE_SMOKE === "1";

describe.skipIf(!claudeOk)("probe live smoke — real claude capability (D5)", () => {
  it("detectCapability invokes the real claude CLI and records a version", async () => {
    const cap = await createClaudeAdapter().detectCapability();
    expect(cap.available).toBe(true);
    expect(cap.binaryVersion && cap.binaryVersion.length).toBeTruthy();
  });
});

describe.skipIf(!codexOk)("probe live smoke — real codex capability (D5)", () => {
  it("detectCapability invokes the real codex CLI and records a version", async () => {
    const cap = await createCodexAdapter().detectCapability();
    expect(cap.available).toBe(true);
    expect(cap.binaryVersion && cap.binaryVersion.length).toBeTruthy();
  });
});

// A real model call — opt-in (PROBE_LIVE_SMOKE=1) AND binary present. Costs money; off by default.
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!liveRun || !codexOk)("probe live smoke — real codex end-to-end (opt-in)", () => {
  it(
    "a real freeform probe returns a terminal envelope with a captured message",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-smoke-"));
      tmpDirs.push(root);
      const service = new ProbeService({
        adapters: new Map([["codex", createCodexAdapter()]]),
        store: new ProbeStore(root),
      });
      const { runId, done } = await service.launch({
        runtime: "codex",
        archetype: "freeform",
        brief: { task: "Reply with exactly the single word OK and nothing else." },
        cwd: process.cwd(), // a real project dir (codex misbehaves in a bare empty tmpdir)
        timeoutMs: 120_000,
      });
      const env = await done;
      expect(env.runId).toBe(runId);
      // a REAL clean answer — this is the meaningful regression guard (not just "any terminal outcome")
      expect(env.status).toBe("completed");
      expect(env.result?.reason).toBe("ok");
      expect(env.result?.lastMessage.toUpperCase()).toContain("OK");
      // and it is recoverable from the store by runId
      expect((await service.read(runId))?.runId).toBe(runId);
    },
    140_000,
  );
});
