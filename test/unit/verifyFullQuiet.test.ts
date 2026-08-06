import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- importing the owned .mjs runner directly is the behavior under test.
import { FAILURE_LIMITS, STATIC_GATES, describeChildExit, formatFailure, formatSuccess, summarizeReport, summarizeUnavailableCoverage } from "../../scripts/verify-full.mjs";
// @ts-expect-error -- same: the reporter the gate hands to Vitest is plain ESM the gate owns.
import { UNHANDLED_OUTPUT_ENV } from "../../scripts/vitest-unhandled-reporter.mjs";

const repoRoot = process.cwd();
const runner = path.join(repoRoot, "scripts/verify-full.mjs");
const passingReport = {
  numTotalTests: 12, numPassedTests: 10, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1,
  testResults: [{ status: "passed", name: "one" }, { status: "passed", name: "two" }],
};
const createdPaths = new Set<string>();

function trackRetained(stderr: string) {
  const retained = stderr.match(/Full private log retained at: (.+)/)?.[1];
  if (retained) createdPaths.add(retained);
  return retained;
}

function cleanupCreatedPaths() {
  for (const target of createdPaths) fs.rmSync(target, { recursive: true, force: true });
  createdPaths.clear();
}

afterEach(cleanupCreatedPaths);

/** t-dcd8eb — the runner now shells the static gates through `npm run <script>`, so a workspace it can
 *  verify is one that DECLARES them. The fixture models that (trivially passing by default); pass
 *  `gates` to make one fail. Production stays fail-closed: a missing script is an error, never a skip. */
function workspace(buildSource = "", vitestSource?: string, gates: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-full-quiet-test-"));
  createdPaths.add(root);
  // t-62cc44 — DERIVED from STATIC_GATES rather than listing the gate names again. The hand-written
  // version declared exactly two scripts, so adding a third gate made every test here fail with npm's
  // "missing script" exit 1 — a fixture drifting from the list it stands in for, which is the same
  // failure mode the gate list itself is designed to avoid.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "verify-full-fixture",
    scripts: Object.fromEntries((STATIC_GATES as string[]).map((gate) => [gate, gates[gate] ?? "node -e 0"])),
  }));
  fs.mkdirSync(path.join(root, "node_modules/vitest"), { recursive: true });
  fs.writeFileSync(path.join(root, "esbuild.mjs"), buildSource || "console.log('PASSED BUILD NOISE')\n");
  fs.writeFileSync(path.join(root, "node_modules/vitest/vitest.mjs"), vitestSource ?? `
    import fs from "node:fs";
    const output = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice(13);
    fs.writeFileSync(output, process.env.FAKE_REPORT);
    console.log("PASSED FILE AND TEST NOISE");
    process.exit(Number(process.env.FAKE_EXIT ?? 0));
  `);
  return root;
}

function execute(root: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const lockPath = path.join(root, "verify-full.lock");
    const child = spawn(process.execPath, [runner], { cwd: root, env: { ...process.env, TACHYON_VERIFY_FULL_LOCK_PATH: lockPath, FAKE_REPORT: JSON.stringify(passingReport), ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => { trackRetained(stderr); resolve({ code, stdout, stderr }); });
  });
}

describe("quiet full verification", () => {
  it("formats exact file and test counters without passed noise", () => {
    expect(summarizeReport(passingReport)).toEqual({ files: 2, passedFiles: 2, failedFiles: 0,
      total: 12, passed: 10, failed: 0, skipped: 1, todo: 1 });
    expect(formatSuccess(passingReport)).toBe("verify:full:quiet passed\nFiles: 2 passed (2)\nTests: 10 passed | 1 skipped | 1 todo (12)");
  });

  it("reports native credential skips by reason without changing their result", () => {
    const report = {
      ...passingReport,
      testResults: [{ status: "passed", assertionResults: [
        { status: "skipped", meta: { optionalRuntimeAuthUnavailable: "claude" } },
        { status: "skipped", meta: { optionalRuntimeAuthUnavailable: "claude" } },
        { status: "skipped", meta: { optionalRuntimeAuthUnavailable: "opencode" } },
        { status: "skipped", meta: {} },
      ] }],
    };
    expect(summarizeUnavailableCoverage(report)).toEqual([
      { reason: "optional claude credential unavailable", count: 2 },
      { reason: "optional opencode credential unavailable", count: 1 },
    ]);
    expect(formatSuccess(report)).toContain(
      "Coverage unavailable (native test skips):\n- 2: optional claude credential unavailable\n- 1: optional opencode credential unavailable",
    );
    expect(report.testResults.map((file) => file.assertionResults.map((test) => test.status)))
      .toEqual([["skipped", "skipped", "skipped", "skipped"]]);
  });

  it("bounds assertion count, each assertion, and total diagnostics", () => {
    const report = { testResults: [{ status: "failed", assertionResults: Array.from({ length: 20 }, (_, index) => ({
      status: "failed", fullName: `failure ${index}`, failureMessages: ["x".repeat(10_000)],
    })) }] };
    const output = formatFailure({ phase: "tests", report, logDir: "/private/log" });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(FAILURE_LIMITS.totalBytes);
    expect(output).toContain("1. failure 0");
    expect(output).toContain("10. failure 9");
    expect(output).not.toContain("11. failure 10");
    expect(output).toContain("10 more assertion failure(s) omitted");
    expect(output).toContain("npm run verify:full");
  });

  it("includes bounded deduplicated file-level infrastructure diagnostics", () => {
    const report = { testResults: [{ status: "failed", name: "broken.test.ts",
      message: "SyntaxError: broken import", assertionResults: [] }] };
    const output = formatFailure({ phase: "tests", report, logDir: "/private/log" });
    expect(output).toContain("broken.test.ts");
    expect(output.match(/SyntaxError: broken import/g)).toHaveLength(1);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(FAILURE_LIMITS.totalBytes);
  });

  it("runs build then full Vitest quietly, reports below 1 KiB, and cleans success temp", async () => {
    const root = workspace();
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tachyon-verify-full-")));
    const result = await execute(root);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/^\[verify:full\] ok: MemAvailable \d+MB \/ total \d+MB → workers=\d+ \(auto-sized; grows with free RAM\)\n$/);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(256);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1024);
    expect(result.stdout).toContain("Files: 2 passed (2)");
    expect(result.stdout).not.toContain("PASSED BUILD NOISE");
    expect(result.stdout).not.toContain("PASSED FILE AND TEST NOISE");
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tachyon-verify-full-") && !before.has(name));
    expect(after).toEqual([]);
  });

  it("removes every tracked test fixture and retained production log", () => {
    const fixture = workspace();
    const retained = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-verify-full-"));
    createdPaths.add(retained);
    cleanupCreatedPaths();
    expect(fs.existsSync(fixture)).toBe(false);
    expect(fs.existsSync(retained)).toBe(false);
  });

  it("preserves test failure status and retains a private bounded diagnostic log", async () => {
    const report = { ...passingReport, numFailedTests: 1, numPassedTests: 9,
      testResults: [{ status: "failed", assertionResults: [{ status: "failed", fullName: "useful failure", failureMessages: ["expected true"] }] }] };
    const result = await execute(workspace(), { FAKE_REPORT: JSON.stringify(report), FAKE_EXIT: "7" });
    expect(result.code).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed during tests");
    expect(result.stderr).toContain("useful failure");
    const retained = trackRetained(result.stderr);
    expect(retained).toBeTruthy();
    expect(fs.statSync(retained!).mode & 0o777).toBe(0o700);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(FAILURE_LIMITS.totalBytes + 1);
  });

  it("fails closed when the JSON report records failures even if Vitest exits zero", async () => {
    const report = { ...passingReport, success: false, numFailedTests: 1, numPassedTests: 9,
      testResults: [{ status: "failed", assertionResults: [{ status: "failed", fullName: "reported failure", failureMessages: ["expected true"] }] }] };
    const result = await execute(workspace(), { FAKE_REPORT: JSON.stringify(report), FAKE_EXIT: "0" });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed during tests");
    expect(result.stderr).toContain("reported failure");
  });

  /**
   * t-d62d90 — the INVERSE question, pinned as a truth table rather than as prose.
   *
   * The observed defect is a red gate with a green report (2/6 under 16 workers), and the question it
   * raised is the one that decides whether any green this repo attested means anything: can the gate
   * exit ZERO while the report is red — or absent, or unreadable? Reading the condition is not an
   * answer, because the condition is one line and the return value below it is another: the branch
   * returns `tests.code || 1`, so the cell that matters most (report red, Vitest exit 0) depends on
   * that `|| 1` and on nothing else.
   *
   * So every cell runs through the production door — the real runner, spawned, with a fake Vitest —
   * and the assertion is the same in all of them: zero is reachable ONLY when the child exited zero,
   * unsignalled, AND the report parsed AND the report is green. One cell per way of being red.
   */
  describe("tests phase: zero is reachable only when EVERY signal is green", () => {
    const greenExit = { FAKE_EXIT: "0" };

    it("exits zero when the child exits zero and the report is green", async () => {
      const result = await execute(workspace(), greenExit);
      expect(result.code).toBe(0);
    });

    // The measured defect itself: report green, exit non-zero. The gate must stay RED — and must now
    // say which of the two doors it came through, because the report and the log both say nothing.
    it("stays red when the child exits non-zero with a fully green report, and names the code", async () => {
      const result = await execute(workspace(), { FAKE_EXIT: "1" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("failed during tests");
      expect(result.stderr).toContain("child exited with code 1");
    });

    // A child killed AFTER writing its report — the shape a dying worker or an outside kill produces.
    // `code` is null here, so a message built from the exit code alone would report the coerced 1 and
    // send the reader looking for a Vitest that failed on its own.
    it("stays red when the child is killed by a signal after writing a green report, and names the signal", async () => {
      const result = await execute(workspace("", `
        import fs from "node:fs";
        const output = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice(13);
        fs.writeFileSync(output, process.env.FAKE_REPORT);
        process.kill(process.pid, "SIGKILL");
      `), greenExit);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("failed during tests");
      expect(result.stderr).toContain("child killed by SIGKILL");
      expect(result.stderr).not.toContain("exited with code");
    });

    /**
     * The false-GREEN half of the same defect. Vitest checks its unhandled-error list once, before
     * reporters are told the run finished; one that arrives after that moment sets no exit code, is
     * dropped by the JSON reporter, and would leave the gate green over a real error. Here the fake
     * Vitest exits zero with a green report and only the side channel disagrees.
     */
    it("stays red on unhandled errors even when the child exits zero with a green report", async () => {
      const result = await execute(workspace("", `
        import fs from "node:fs";
        const output = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice(13);
        fs.writeFileSync(output, process.env.FAKE_REPORT);
        fs.writeFileSync(process.env["${UNHANDLED_OUTPUT_ENV}"], JSON.stringify([
          { type: "Unhandled Rejection", message: "LATE REJECTION DETAIL", stack: "Error: LATE REJECTION DETAIL",
            testPath: "test/unit/somewhere.test.ts", afterEnvironmentTeardown: true },
        ]));
        process.exit(0);
      `), greenExit);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("failed during tests");
      expect(result.stderr).toContain("1 unhandled error(s) outside any test");
      expect(result.stderr).toContain("LATE REJECTION DETAIL");
      expect(result.stderr).toContain("test/unit/somewhere.test.ts");
      expect(result.stderr).toContain("after environment teardown");
    });

    it("stays red when the child exits zero having written no report at all", async () => {
      const result = await execute(workspace("", "process.exit(0);\n"), greenExit);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("failed during tests");
    });

    it("stays red when the child exits zero and the report is unparseable", async () => {
      const result = await execute(workspace("", `
        import fs from "node:fs";
        const output = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice(13);
        fs.writeFileSync(output, "{ truncated");
        process.exit(0);
      `), greenExit);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("failed during tests");
    });
  });

  it("falls back to a bounded build tail when no JSON report exists", async () => {
    const result = await execute(workspace("console.error('BUILD FAILURE DETAIL'); process.exit(4)\n"));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("failed during build");
    expect(result.stderr).toContain("BUILD FAILURE DETAIL");
    expect(result.stderr).toContain("npm run verify:full");
  });

  // t-dcd8eb — the static gates are part of THIS command, not of the CI workflow. Before, `verify:full`
  // ran build+tests only, so the pre-push gate resolving it never typechecked and the engine-boundary
  // guard sat red on main unnoticed once Actions ran out of credit.
  it("runs a failing static gate BEFORE the build, and stops there", async () => {
    const root = workspace(
      "console.error('BUILD SHOULD NOT RUN'); process.exit(4)\n",
      undefined,
      { typecheck: "node -e \"console.error('TYPE ERROR DETAIL'); process.exit(2)\"" },
    );
    const result = await execute(root);
    expect(result.code).toBe(2); // the gate's own exit code, not the build's 4
    expect(result.stderr).toContain("failed during typecheck");
    expect(result.stderr).toContain("TYPE ERROR DETAIL");
    expect(result.stderr).not.toContain("BUILD SHOULD NOT RUN"); // never reached the build
  });

  it("orders the static gates cheapest-first so a 100ms guard never waits on a 19s one", async () => {
    // Both fail; the FIRST one declared must be the one reported.
    const result = await execute(workspace("", undefined, {
      "check:engine-boundary": "node -e \"console.error('BOUNDARY FIRST'); process.exit(3)\"",
      typecheck: "node -e \"console.error('TYPECHECK SECOND'); process.exit(2)\"",
    }));
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("failed during check:engine-boundary");
    expect(result.stderr).not.toContain("TYPECHECK SECOND");
  });

  it("forwards SIGTERM to the active child and exits with signal status", async () => {
    const root = workspace(`
      import fs from "node:fs";
      fs.writeFileSync("ready", String(process.pid));
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [runner], { cwd: root, env: { ...process.env, TACHYON_VERIFY_FULL_LOCK_PATH: path.join(root, "verify-full.lock") } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    for (let index = 0; index < 100 && !fs.existsSync(path.join(root, "ready")); index++) await new Promise((resolve) => setTimeout(resolve, 10));
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    const code = await closed;
    trackRetained(stderr);
    expect(code).toBe(143);
  });

  /**
   * t-d62d90 — the reporter is a courier and nothing else. It must dump at process exit (the only
   * moment late errors exist), it must stay silent when there is nothing to carry, and it must never
   * write anywhere the gate did not ask it to.
   */
  describe("unhandled-error reporter", () => {
    const reporterPath = path.join(repoRoot, "scripts/vitest-unhandled-reporter.mjs");

    function driveReporter(errors: unknown[], outputFile?: string) {
      const script = `
        import Reporter from ${JSON.stringify(reporterPath)};
        new Reporter().onInit({ state: { getUnhandledErrors: () => (${JSON.stringify(errors)}) } });
      `;
      const env = { ...process.env, [UNHANDLED_OUTPUT_ENV]: outputFile } as NodeJS.ProcessEnv;
      if (!outputFile) delete env[UNHANDLED_OUTPUT_ENV];
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env });
        child.on("error", reject);
        child.on("close", () => resolve());
      });
    }

    it("writes the errors Vitest collected, keeping the worker's file and teardown tags", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-full-unhandled-test-"));
      createdPaths.add(root);
      const outputFile = path.join(root, "unhandled.json");
      await driveReporter([{
        type: "Unhandled Rejection", name: "Error", message: "boom", stack: "Error: boom\n    at nowhere",
        VITEST_TEST_PATH: "test/unit/leaky.test.ts", VITEST_TEST_NAME: "a leaky test", VITEST_AFTER_ENV_TEARDOWN: true,
      }], outputFile);
      const written = JSON.parse(fs.readFileSync(outputFile, "utf8"));
      expect(written).toEqual([{
        type: "Unhandled Rejection", name: "Error", message: "boom", stack: "Error: boom\n    at nowhere",
        testPath: "test/unit/leaky.test.ts", testName: "a leaky test", afterEnvironmentTeardown: true,
      }]);
      expect(fs.statSync(outputFile).mode & 0o777).toBe(0o600);
    });

    it("writes nothing at all when the run collected no unhandled error", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-full-unhandled-test-"));
      createdPaths.add(root);
      const outputFile = path.join(root, "unhandled.json");
      await driveReporter([], outputFile);
      expect(fs.existsSync(outputFile)).toBe(false);
    });

    it("is inert for every Vitest invocation that did not ask for the side channel", async () => {
      // `npm test` and a focused run load no env var, so the reporter must be a no-op there.
      await expect(driveReporter([{ message: "boom" }])).resolves.toBeUndefined();
    });
  });

  it("describes each way a child can end, without inventing an exit code it never had", () => {
    expect(describeChildExit({ code: 3, signal: undefined })).toBe("child exited with code 3");
    // runChild coerces a signalled child's null code to 1; the signal must still win the message.
    expect(describeChildExit({ code: 1, signal: "SIGKILL" })).toBe("child killed by SIGKILL, no exit code");
    expect(describeChildExit({ code: 1, signal: undefined, error: new Error("ENOENT") })).toBe("child never ran: ENOENT");
  });

  it("declares the governed quiet runner as the canonical full verification entry point", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(packageJson.scripts["verify:full"]).toBe("node scripts/verify-full.mjs");
    expect(packageJson.scripts["verify:full:quiet"]).toBe("node scripts/verify-full.mjs");
    const config = fs.readFileSync(path.join(repoRoot, "tachyon.yml.example"), "utf8");
    expect(config).toMatch(/verify:\n\s+full: npm run verify:full:quiet/);
    expect(config.match(/^\s+full:\s+npm run verify:full:quiet\s*$/gm)).toHaveLength(1);
  });
});
