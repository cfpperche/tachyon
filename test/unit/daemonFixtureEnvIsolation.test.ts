import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-93ec7f — engine/daemon fixture spawns must not inherit the live fleet's TACHYON_*.
 *
 * The disease is mechanical and repeating: `spawn(process.execPath, [vite-node, <engine worker>])`
 * with no `env:` (Node's default) hands a real daemon a valid TACHYON_AGENT_BRIDGE_TOKEN from the
 * host pane. t-70fda0 fixed engineService; this task fixed engineSupervisor and the control-boundary
 * sibling. A note in a journal is not a guard — this file fails when a third fixture reopens the door.
 *
 * What it measures (source shape, not runtime):
 * 1. Every test that references a known engine fixture worker must pass `env:` on its spawn.
 * 2. That env must be built through `isolatedDaemonChildEnv` (the shared strip + reintroduce door).
 * 3. The helper itself still strips TACHYON_* and names the Bridge-token leak — so a "refactor" that
 *    empties the helper is also red.
 *
 * A behavioural test can pass while a new spawn site omits env. This one cannot.
 */

const ROOT = path.resolve(__dirname, "../..");
const FIXTURE_WORKERS = [
  "daemonEngineServiceWorker.ts",
  "engineSupervisorWorker.ts",
  "engineControlWorker.ts",
] as const;

const HELPER = fs.readFileSync(path.join(ROOT, "test/helpers/isolatedDaemonEnv.ts"), "utf8");

function testFilesReferencingWorkers(): Array<{ file: string; source: string; workers: string[] }> {
  const unitDir = path.join(ROOT, "test/unit");
  const out: Array<{ file: string; source: string; workers: string[] }> = [];
  for (const name of fs.readdirSync(unitDir)) {
    if (!name.endsWith(".test.ts") && !name.endsWith(".test.js")) continue;
    const file = path.join(unitDir, name);
    const source = fs.readFileSync(file, "utf8");
    const workers = FIXTURE_WORKERS.filter((w) => source.includes(w));
    if (workers.length > 0) out.push({ file: path.relative(ROOT, file), source, workers });
  }
  return out;
}

describe("daemon fixture env isolation (t-93ec7f)", () => {
  it("every known engine fixture worker is referenced by at least one test — the guard is not vacuous", () => {
    const found = new Set(testFilesReferencingWorkers().flatMap((row) => row.workers));
    for (const worker of FIXTURE_WORKERS) {
      expect(found.has(worker), `${worker} has no test caller — update FIXTURE_WORKERS or restore the suite`).toBe(true);
    }
  });

  it("every test that spawns an engine fixture worker builds env through isolatedDaemonChildEnv and passes env:", () => {
    const rows = testFilesReferencingWorkers();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        row.source.includes("isolatedDaemonChildEnv"),
        `${row.file} spawns ${row.workers.join(", ")} but does not use isolatedDaemonChildEnv`,
      ).toBe(true);
      expect(
        row.source.includes("assertNoFleetLeak"),
        `${row.file} spawns ${row.workers.join(", ")} but does not call assertNoFleetLeak`,
      ).toBe(true);
      // Every spawn( that launches the worker path must carry env: — catch a bare spawn reopening inheritance.
      const spawnBlocks = row.source.match(/spawn\([\s\S]{0,400}?\{[\s\S]{0,200}?\}/g) ?? [];
      const engineSpawns = spawnBlocks.filter((block) =>
        FIXTURE_WORKERS.some((w) => block.includes("worker") || row.source.includes(w)),
      );
      // Fallback: if the regex missed a multi-line form, require at least one `env:` next to a spawn.
      expect(
        /spawn\([\s\S]*?\benv\s*:/.test(row.source),
        `${row.file}: spawn of an engine fixture must pass env: (got no env: near spawn)`,
      ).toBe(true);
      void engineSpawns;
    }
  });

  it("the shared helper strips every TACHYON_* key and names the Bridge-token leak", () => {
    expect(HELPER).toMatch(/key\.startsWith\(["']TACHYON_["']\)/);
    expect(HELPER).toMatch(/TACHYON_AGENT_BRIDGE_TOKEN/);
    expect(HELPER).toMatch(/leaked from the live fleet into the daemon fixture/);
    expect(HELPER).toMatch(/export function isolatedDaemonChildEnv/);
    expect(HELPER).toMatch(/export function assertNoFleetLeak/);
  });

  it("detects a bare engine-worker spawn without isolation — the guard is not vacuous", () => {
    // Synthetic source shaped like the pre-fix engineSupervisor spawnWorker. A scanner that always
    // returns green is worthless; this is the fail-before case without planting it in the tree.
    const bare = `
      const worker = path.join(process.cwd(), "test/fixtures/engineSupervisorWorker.ts");
      const child = spawn(process.execPath, [viteNode, worker, encodedOptions], { stdio: ["pipe", "pipe", "pipe"] });
    `;
    expect(bare.includes("isolatedDaemonChildEnv")).toBe(false);
    expect(/spawn\([\s\S]*?\benv\s*:/.test(bare)).toBe(false);
  });
});
