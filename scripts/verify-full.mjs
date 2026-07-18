import { chmodSync, closeSync, createReadStream, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync, constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decideHeavyGate } from "./host-resources.mjs";

export const FAILURE_LIMITS = Object.freeze({ assertions: 10, assertionBytes: 2 * 1024, totalBytes: 24 * 1024 });

/** Dynamic: prefer decideHeavyGate().workers; kept as function for tests that pin env. */
export function resolveVitestMaxWorkers() {
  return decideHeavyGate({ cpuCount: cpus().length || 1 }).workers;
}

/** @deprecated use resolveVitestMaxWorkers — export for lock tests backward compat */
export const VITEST_MAX_WORKERS = resolveVitestMaxWorkers();

/** t-6a9bc4: at most one full-suite gate host-wide (verify_task + agent contracts share this entrypoint). */
export const VERIFY_FULL_LOCK_PATH = process.env.TACHYON_VERIFY_FULL_LOCK_PATH || path.join(tmpdir(), "tachyon-verify-full.lock");

export function acquireVerifyFullLock(lockPath = VERIFY_FULL_LOCK_PATH) {
  try {
    const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    closeSync(fd);
    return {
      path: lockPath,
      release() {
        try { unlinkSync(lockPath); } catch { /* best-effort */ }
      },
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      let holder = "(unknown)";
      try { holder = readFileSync(lockPath, "utf8").trim().split("\n")[0] || holder; } catch { /* ignore */ }
      // Stale lock: holder PID gone → steal.
      const pid = Number(holder);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch {
          try { unlinkSync(lockPath); } catch { /* ignore */ }
          return acquireVerifyFullLock(lockPath);
        }
      }
      const err = new Error(
        `verify:full refused: another full-suite gate is already running (holder pid ${holder}). ` +
          `t-6a9bc4 control-plane protection — wait for it to finish or remove stale ${lockPath}.`,
      );
      err.code = "VERIFY_FULL_BUSY";
      throw err;
    }
    throw error;
  }
}

function truncateBytes(value, limit) {
  const bytes = Buffer.from(String(value));
  if (bytes.length <= limit) return String(value);
  return `${bytes.subarray(0, Math.max(0, limit - 16)).toString("utf8")}\n… truncated`;
}

export function summarizeReport(report) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  const failedFiles = results.filter((result) => result?.status === "failed"
    || result?.assertionResults?.some((assertion) => assertion?.status === "failed")).length;
  const files = results.length;
  const total = Number(report?.numTotalTests ?? 0);
  const passed = Number(report?.numPassedTests ?? 0);
  const failed = Number(report?.numFailedTests ?? 0);
  const skipped = Number(report?.numPendingTests ?? 0);
  const todo = Number(report?.numTodoTests ?? 0);
  return { files, passedFiles: files - failedFiles, failedFiles, total, passed, failed, skipped, todo };
}

export function formatSuccess(report) {
  const count = summarizeReport(report);
  const testParts = [`${count.passed} passed`];
  if (count.failed) testParts.push(`${count.failed} failed`);
  if (count.skipped) testParts.push(`${count.skipped} skipped`);
  if (count.todo) testParts.push(`${count.todo} todo`);
  return [
    "verify:full:quiet passed",
    `Files: ${count.passedFiles} passed (${count.files})`,
    `Tests: ${testParts.join(" | ")} (${count.total})`,
  ].join("\n");
}

function assertionFailures(report) {
  const failures = [];
  const seen = new Set();
  const add = (name, message, deduplicate = false) => {
    const text = String(message ?? "");
    if (!text || (deduplicate && seen.has(text))) return;
    seen.add(text);
    failures.push({ name, message: text });
  };
  for (const file of Array.isArray(report?.testResults) ? report.testResults : []) {
    for (const assertion of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      if (assertion?.status !== "failed") continue;
      const messages = Array.isArray(assertion.failureMessages) && assertion.failureMessages.length
        ? assertion.failureMessages : [file?.message ?? file?.failureMessage ?? "Assertion failed"];
      add(assertion.fullName ?? assertion.title ?? file?.name ?? "failed assertion", messages.join("\n"));
    }
    if (file?.status === "failed") add(file.name ?? "failed test file", file.message ?? file.failureMessage, true);
  }
  return failures;
}

export function formatFailure({ phase, report, fallback = "", logDir }) {
  const header = `verify:full:quiet failed during ${phase}`;
  const hint = `Full private log retained at: ${logDir}\nVerbose hint: npm run verify:full`;
  const failures = report ? assertionFailures(report) : [];
  const sections = [header];
  if (failures.length) {
    for (const [index, failure] of failures.slice(0, FAILURE_LIMITS.assertions).entries()) {
      sections.push(truncateBytes(`${index + 1}. ${failure.name}\n${failure.message}`, FAILURE_LIMITS.assertionBytes));
    }
    if (failures.length > FAILURE_LIMITS.assertions) sections.push(`… ${failures.length - FAILURE_LIMITS.assertions} more assertion failure(s) omitted`);
  } else {
    sections.push(truncateBytes(fallback || "No structured diagnostic was produced.", 16 * 1024));
  }
  sections.push(hint);
  return truncateBytes(sections.join("\n\n"), FAILURE_LIMITS.totalBytes - 1);
}

function privateFile(file) {
  return openSync(file, "w", 0o600);
}

function runChild(command, args, logFile, active) {
  const fd = privateFile(logFile);
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", fd, fd] });
    active.child = child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      closeSync(fd);
      active.child = undefined;
      resolve(result);
    };
    child.once("error", (error) => finish({ code: 1, signal: undefined, error }));
    child.once("close", (code, signal) => finish({ code: code ?? 1, signal }));
  });
}

function readTail(file, maxBytes = 16 * 1024) {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const chunks = [];
    return new Promise((resolve, reject) => {
      createReadStream(file, { start }).on("data", (chunk) => chunks.push(chunk)).on("error", reject)
        .on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  } catch { return Promise.resolve(""); }
}

export async function main() {
  let lock;
  try {
    lock = acquireVerifyFullLock();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "VERIFY_FULL_BUSY") {
      process.stderr.write(`${error.message}\n`);
      return 75; // EX_TEMPFAIL
    }
    throw error;
  }
  // t-019dac: refuse under memory pressure before spending the suite; auto-size workers from free RAM.
  const gate = decideHeavyGate({ cpuCount: cpus().length || 1 });
  if (!gate.ok) {
    process.stderr.write(`${gate.reason}\n`);
    lock?.release();
    return 75;
  }
  const workers = gate.workers;
  process.stderr.write(`[verify:full] ${gate.reason}\n`);

  const root = mkdtempSync(path.join(tmpdir(), "tachyon-verify-full-"));
  chmodSync(root, 0o700);
  const buildLog = path.join(root, "build.log");
  const testLog = path.join(root, "vitest.log");
  const reportFile = path.join(root, "vitest-report.json");
  const active = { child: undefined };
  let receivedSignal;
  const forward = (signal) => { receivedSignal = signal; active.child?.kill(signal); };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    const build = await runChild(process.execPath, ["esbuild.mjs"], buildLog, active);
    if (build.code !== 0 || build.signal || receivedSignal) {
      process.stderr.write(`${formatFailure({ phase: "build", fallback: await readTail(buildLog), logDir: root })}\n`);
      return receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : build.code || 1;
    }
    const vitestEntry = path.resolve("node_modules/vitest/vitest.mjs");
    const tests = await runChild(process.execPath,
      [vitestEntry, "run", `--maxWorkers=${workers}`, "--reporter=json", `--outputFile=${reportFile}`, "--silent=passed-only"], testLog, active);
    let report;
    try { report = JSON.parse(readFileSync(reportFile, "utf8")); } catch { report = undefined; }
    if (tests.code !== 0 || tests.signal || receivedSignal || !report) {
      process.stderr.write(`${formatFailure({ phase: "tests", report, fallback: await readTail(testLog), logDir: root })}\n`);
      return receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : tests.code || 1;
    }
    process.stdout.write(`${formatSuccess(report)}\n`);
    rmSync(root, { recursive: true, force: true });
    return 0;
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    lock?.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
