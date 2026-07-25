import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- importing the owned .mjs runner directly is the behavior under test.
import { FAILURE_LIMITS, formatFailure, formatSuccess, summarizeReport } from "../../scripts/verify-full.mjs";

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
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "verify-full-fixture",
    scripts: {
      "check:engine-boundary": gates["check:engine-boundary"] ?? "node -e 0",
      typecheck: gates.typecheck ?? "node -e 0",
    },
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

  it("declares the governed quiet runner as the canonical full verification entry point", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(packageJson.scripts["verify:full"]).toBe("node scripts/verify-full.mjs");
    expect(packageJson.scripts["verify:full:quiet"]).toBe("node scripts/verify-full.mjs");
    const config = fs.readFileSync(path.join(repoRoot, "tachyon.yml.example"), "utf8");
    expect(config).toMatch(/verify:\n\s+full: npm run verify:full:quiet/);
    expect(config.match(/^\s+full:\s+npm run verify:full:quiet\s*$/gm)).toHaveLength(1);
  });
});
