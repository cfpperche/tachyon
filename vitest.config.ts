import { defineConfig } from "vitest/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideHeavyGate, readHostMemory } from "./src/host/hostResources";
import { admitOrFallback } from "./src/host/vitestBudget";

/**
 * t-019dac: auto-size workers from free RAM (grows if you add memory).
 * Still never nproc-blind; hard-capped inside decideHeavyGate/recommendVitestMaxWorkers.
 * Forced override: TACHYON_VITEST_MAX_WORKERS.
 *
 * t-0b7aa7 — this config is loaded by EVERY vitest invocation, including a single focused file,
 * which is not the heavy gate the refusal is about. So a refusal degrades to one worker here rather
 * than making the suite unrunnable on a busy machine — but it says so. Silently sizing to 1 is how
 * a refusal stops being a refusal: the run proceeds, slowly, and nobody learns why.
 *
 * t-3ad4af — and THIS is where the host-wide budget has to be taken, for the same reason the defect
 * lived here: every vitest invocation loads this file exactly once, in the parent process (measured —
 * 4 workers over 4 files evaluate it once), so it is the single door that both `npm test`, a focused
 * `npx vitest` and the child `verify:full` spawns all pass through. Sizing per process here is what
 * let three concurrent runs divide the same RAM three times and cost the owner a reboot.
 */
const memory = readHostMemory();
const cpuCount = os.cpus().length || 1;
const gate = decideHeavyGate({ memory, cpuCount });
if (!gate.ok) {
  process.stderr.write(`[vitest] ${gate.reason}\n[vitest] degrading to maxWorkers=1 — the heavy gate (verify:full) will refuse outright.\n`);
}

/**
 * How many test files this invocation was explicitly pointed at, or 0 for "everything".
 *
 * Vitest never spawns more workers than it has files, so a focused run that reserved the full
 * worker cap would be reserving RAM it cannot use — and the ledger bills a run its full claim until it
 * outgrows it, so that fiction would refuse the next agent on a machine with plenty of room. The
 * primer tells every agent to run focused tests, so this is the common case, not the corner one.
 *
 * Only ARGUMENTS THAT ARE REAL TEST FILES count. Vitest filters are substrings, not paths — `vitest
 * run hostResources` can match many files — so anything that is not a path to an existing test file
 * is treated as "scope unknown" and gets no cap. Guessing low here would under-reserve a run that
 * then takes the RAM anyway, which is the failure this whole file exists to prevent.
 */
function explicitTestFileCount(): number {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  let named = 0;
  for (const arg of args) {
    if (!/\.test\.[cm]?tsx?$/.test(arg)) continue;
    try {
      if (fs.statSync(path.resolve(arg)).isFile()) named++;
    } catch {
      return 0; // named something we cannot resolve — do not pretend to know the scope
    }
  }
  // Any non-file argument is a filter of unknown breadth: fall back to no cap.
  const nonFileArgs = args.filter((arg) => !/\.test\.[cm]?tsx?$/.test(arg) && arg !== "run" && arg !== "watch");
  return nonFileArgs.length === 0 ? named : 0;
}

const forcedRaw = Number(process.env.TACHYON_VITEST_MAX_WORKERS);
const namedFiles = explicitTestFileCount();
const admission = admitOrFallback({
  memory,
  cpuCount,
  label: process.env.TACHYON_AGENT_NAME || "vitest",
  ...(namedFiles > 0
    ? {
      maxUsefulWorkers: namedFiles,
      // Measured: a focused run's whole tree peaks at 146MB (1 file) to 185MB (4 files), because the
      // ~1.9GB fixed term of a full run is mostly the vitest parent holding 700 files' worth of
      // reporter state plus the heavy subprocesses a handful of tests spawn (one `tsc --noEmit` at
      // 1536MB). Charging a focused run the full-suite fixed cost would be a 10x over-reservation.
      invocationMb: Number(process.env.TACHYON_VITEST_FOCUSED_INVOCATION_MB) || 512,
    }
    : {}),
  // Under memory pressure the old behaviour stands: one worker, loudly. It still takes a claim, so a
  // sibling arriving next sees this run rather than sizing as if the machine were empty.
  ...(gate.ok ? {} : { forcedWorkers: 1 }),
  ...(Number.isFinite(forcedRaw) && forcedRaw >= 1 ? { forcedWorkers: Math.trunc(forcedRaw) } : {}),
  // t-ad8fd2 — no per-process fallback width is passed any more. A run the ledger cannot record is
  // a run no sibling can see, and handing it `gate.workers` (alone-sizing, up to the cap) is the
  // "as if the machine were empty" assumption that emptied the host. It degrades to one worker.
}, (message) => process.stderr.write(`${message}\n`));

if (!admission.ok) {
  // Refuse, do not degrade. An N+1th run costs ~2GB before its first worker, so sizing down does not
  // make it fit — starting it at all is the harm this task exists to stop.
  throw new Error(`[vitest] ${admission.reason}`);
}
process.stderr.write(`[vitest] ${admission.reason}\n`);
// The claim is held for the life of this process; a run killed before `exit` is reaped by pid
// liveness the next time any sizer reads the ledger.
process.on("exit", () => admission.claim.release());

export const VITEST_MAX_WORKERS = admission.workers;

const PROJECT_RESOLVE = {
  alias: {
    vscode: path.resolve(__dirname, "test/mocks/vscode.ts"),
  },
};
const PROJECT_TEST_BASE = {
  environment: "node" as const,
  testTimeout: 30_000,
  hookTimeout: 30_000,
  env: { TACHYON_GLOBAL_SETTINGS_HOME: path.join(os.tmpdir(), "tachyon-vitest-no-global-settings") },
};

export default defineConfig({
  resolve: PROJECT_RESOLVE,
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: VITEST_MAX_WORKERS,
    // t-8f48da — the suite may not leave a tmux server running in a private socket directory. It has
    // to sit here rather than in a test file: a leak is only visible once the LAST worker is done, and
    // nothing orders a test file after the rest. `setup` also stamps the run id that lets the check
    // attribute a server to this run on a host running several agents' suites at once.
    globalSetup: ["test/globalSetup/tmuxLeakGuard.ts"],
    // t-eaf963 — the real Codex prompt projection is scheduler-sensitive work, not ordinary unit
    // work. Projects in the same group run together; group 1 starts only after group 0 has drained.
    // Keep the 10s process bound and the installed CLI coverage, but never make either compete with
    // the parallel pool, whose load caused `spawnSync codex ETIMEDOUT` when it was 16 workers wide.
    // t-fb7025 halved that width; the separation stays, because the failure was contention and a
    // narrower pool makes it rarer rather than impossible.
    projects: [
      {
        resolve: PROJECT_RESOLVE,
        test: {
          ...PROJECT_TEST_BASE,
          name: "parallel",
          include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
          exclude: ["test/unit/harnessCodexDogfood.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: PROJECT_RESOLVE,
        test: {
          ...PROJECT_TEST_BASE,
          name: "codex-dogfood",
          include: ["test/unit/harnessCodexDogfood.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
    ],
    // t-aaad95 — never let the suite read the DEVELOPER's real ~/.tachyon/settings.json. A machine
    // where somebody has set a card template would otherwise disagree with CI, and the failure gives
    // no hint that a file outside the repo caused it. Tests that want a document write one into their
    // own temp home via `useGlobalSettingsHome`.
    env: { TACHYON_GLOBAL_SETTINGS_HOME: path.join(os.tmpdir(), "tachyon-vitest-no-global-settings") },
  },
});
