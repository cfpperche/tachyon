import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- importing the owned .mjs runner directly is the behavior under test.
import { FAILURE_LIMITS, formatFailure, formatSuccess, summarizeReport } from "../../scripts/verify-full.mjs";

const repoRoot = process.cwd();
const runner = path.join(repoRoot, "scripts/verify-full.mjs");
const passingReport = {
  numTotalTests: 12, numPassedTests: 10, numFailedTests: 0, numPendingTests: 1, numTodoTests: 1,
  testResults: [{ status: "passed", name: "one" }, { status: "passed", name: "two" }],
};

function workspace(buildSource = "", vitestSource?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-full-quiet-test-"));
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
    const child = spawn(process.execPath, [runner], { cwd: root, env: { ...process.env, FAKE_REPORT: JSON.stringify(passingReport), ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
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

  it("runs build then full Vitest quietly, reports below 1 KiB, and cleans success temp", async () => {
    const root = workspace();
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tachyon-verify-full-")));
    const result = await execute(root);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1024);
    expect(result.stdout).toContain("Files: 2 passed (2)");
    expect(result.stdout).not.toContain("PASSED BUILD NOISE");
    expect(result.stdout).not.toContain("PASSED FILE AND TEST NOISE");
    const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tachyon-verify-full-") && !before.has(name));
    expect(after).toEqual([]);
  });

  it("preserves test failure status and retains a private bounded diagnostic log", async () => {
    const report = { ...passingReport, numFailedTests: 1, numPassedTests: 9,
      testResults: [{ status: "failed", assertionResults: [{ status: "failed", fullName: "useful failure", failureMessages: ["expected true"] }] }] };
    const result = await execute(workspace(), { FAKE_REPORT: JSON.stringify(report), FAKE_EXIT: "7" });
    expect(result.code).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed during tests");
    expect(result.stderr).toContain("useful failure");
    const retained = result.stderr.match(/Full private log retained at: (.+)/)?.[1];
    expect(retained).toBeTruthy();
    expect(fs.statSync(retained!).mode & 0o777).toBe(0o700);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(FAILURE_LIMITS.totalBytes + 1);
  });

  it("falls back to a bounded build tail when no JSON report exists", async () => {
    const result = await execute(workspace("console.error('BUILD FAILURE DETAIL'); process.exit(4)\n"));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("failed during build");
    expect(result.stderr).toContain("BUILD FAILURE DETAIL");
    expect(result.stderr).toContain("npm run verify:full");
  });

  it("forwards SIGTERM to the active child and exits with signal status", async () => {
    const root = workspace(`
      import fs from "node:fs";
      fs.writeFileSync("ready", String(process.pid));
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [runner], { cwd: root });
    for (let index = 0; index < 100 && !fs.existsSync(path.join(root, "ready")); index++) await new Promise((resolve) => setTimeout(resolve, 10));
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(143);
  });

  it("declares quiet orchestration while preserving the verbose package script byte-for-byte", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(packageJson.scripts["verify:full"]).toBe("node esbuild.mjs && vitest run");
    expect(packageJson.scripts["verify:full:quiet"]).toBe("node scripts/verify-full.mjs");
    const config = fs.readFileSync(path.join(repoRoot, "tachyon.yml"), "utf8");
    expect(config).toMatch(/verify:\n\s+full: npm run verify:full:quiet/);
    expect(config.match(/npm run verify:full:quiet/g)).toHaveLength(1);
  });
});
