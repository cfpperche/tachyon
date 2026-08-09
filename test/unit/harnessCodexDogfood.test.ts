import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HarnessManager } from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";
import { requireMachineDependency } from "../helpers/machineDependency.js";

/**
 * t-eaf963 — this real-CLI dogfood lives in its own later Vitest project group.
 *
 * Measured on codex-cli 0.146.1: the command consumes only 0.50s of CPU and performs effectively no
 * I/O (3 major faults, 16 bytes read) under the 16-worker suite, yet wall time follows scheduler
 * share: 1.21s idle, 3.17–5.55s with 300 runnable competitors, and ETIMEDOUT at the unchanged 10s
 * limit under the controlled four-CPU/120-competitor arm. The temporary CODEX_HOME is not the wait,
 * and this is the suite's only `codex debug prompt-input` spawn.
 *
 * `sequence.groupOrder` in vitest.config.ts keeps this project out of the parallel pool. The test
 * still drives the installed CLI through its public executable and still proves both model-visible
 * resources; only competition with the unit pool is removed.
 */
/**
 * t-a12966 — the dependency this dogfood has always had, said out loud.
 *
 * `execFileSync("codex", …)` on a machine without codex installed throws ENOENT, and the test went
 * red naming a spawn error rather than the missing CLI. It must NOT become a double: what it proves
 * is that the real codex reads the harness we materialize, and a stubbed codex proves nothing about
 * that. So it declares the binary and skips with the reason when it is absent.
 */
requireMachineDependency(() => {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return undefined;
  } catch {
    return "codex CLI not installed (spec 311 dogfood drives the real binary)";
  }
});

it("spec 311 dogfood: local codex prompt-input sees harness AGENTS.md and CODEX_HOME skills", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-codex-dogfood-"));
  try {
    const ws = path.join(base, "ws");
    const realHome = path.join(base, "realhome");
    const codexHome = path.join(base, "realcodex");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(realHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
    fs.mkdirSync(path.join(ws, "agents"), { recursive: true });
    fs.writeFileSync(path.join(ws, "agents", "researcher.md"), "# Researcher\nUse TachyonCodexDogfoodProof.\n");
    fs.mkdirSync(path.join(ws, "skills", "research"), { recursive: true });
    fs.writeFileSync(path.join(ws, "skills", "research", "SKILL.md"), "---\nname: research\ndescription: Use when proving Tachyon Codex harness dogfood.\n---\nSkill body.\n");

    const codex = adapterForRuntime("codex")!;
    const mgr = new HarnessManager(ws, realHome, {}, path.join(realHome, ".claude.json"), codexHome);
    const res = mgr.materialize("coder", {
      inherit: "none",
      instructions: ["agents/researcher.md"],
      skills: ["skills/research"],
    }, codex);

    const out = execFileSync("codex", ["debug", "prompt-input", "hello"], {
      cwd: ws,
      env: { ...process.env, CODEX_HOME: res.home },
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toContain("TachyonCodexDogfoodProof");
    expect(out).toContain("research: Use when proving Tachyon Codex harness dogfood.");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
