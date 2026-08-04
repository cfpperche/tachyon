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

  it("FIXTURE_WORKERS covers every worker fixture on disk — a FOURTH one cannot escape by being new", () => {
    // The list above is written by hand, which is correct: not every worker fixture is a daemon that
    // could hold a live Bridge token, and that judgement is a human's. What must NOT be a human's job is
    // NOTICING that a new one appeared. So the completeness of the list is checked against the directory
    // rather than trusted: a fourth fixture makes this red, and whoever adds it has to classify it —
    // either into FIXTURE_WORKERS, or into the exemption below with a reason.
    //
    // Exempt, with reasons measured in this task's repo scan: none today. When the first exemption is
    // needed, it lands here as a named entry, not as a silent omission from the list above.
    const EXEMPT: ReadonlySet<string> = new Set<string>();
    const onDisk = fs.readdirSync(path.join(ROOT, "test/fixtures"))
      .filter((n) => n.endsWith("Worker.ts"))
      .filter((n) => !EXEMPT.has(n));
    const unlisted = onDisk.filter((n) => !FIXTURE_WORKERS.includes(n as typeof FIXTURE_WORKERS[number]));
    expect(
      unlisted,
      `worker fixtures on disk that FIXTURE_WORKERS does not name: ${unlisted.join(", ")}. If one of these ` +
      "spawns a real daemon, add it to FIXTURE_WORKERS so its spawn sites are checked. If it cannot hold a " +
      "live Bridge token, add it to EXEMPT with the reason — but decide, do not leave it unnamed.",
    ).toEqual([]);
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
      // Every spawn( that launches the worker path must carry env: — catch a bare spawn reopening
      // inheritance. This is a whole-file check rather than a per-spawn one, and the limit is stated
      // rather than hidden: a file with two spawns, one isolated and one bare, passes here. The
      // per-spawn version needs a parser, and the three files this covers have one spawn each — so the
      // honest guard is this one plus the fact that a fourth file is caught by the completeness test
      // above. (An earlier revision computed a per-block match and then discarded it, which read like a
      // stronger check than it was.)
      expect(
        /spawn\([\s\S]*?\benv\s*:/.test(row.source),
        `${row.file}: spawn of an engine fixture must pass env: (got no env: near spawn)`,
      ).toBe(true);
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
