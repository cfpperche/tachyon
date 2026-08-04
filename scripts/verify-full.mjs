import { chmodSync, closeSync, createReadStream, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, unlinkSync, constants as fsConstants } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decideHeavyGate } from "./host-resources.mjs";
import { recordVerification, reuseDecision, verifiableTree, verifierFingerprint } from "./verify-record.mjs";

export const FAILURE_LIMITS = Object.freeze({ assertions: 10, assertionBytes: 2 * 1024, totalBytes: 24 * 1024 });

/**
 * t-0b7aa7 — hand back the DECISION, never a bare worker count.
 *
 * The two exports this replaces were `resolveVitestMaxWorkers()`, which returned
 * `decideHeavyGate(...).workers`, and a module-load-time `VITEST_MAX_WORKERS` const built from it.
 * Both read the sizing field off an answer that may be a refusal, so under memory pressure they
 * reported `0` workers — a refusal wearing the clothes of a measurement. Nothing in this file used
 * either one (main() calls the gate itself and checks `ok`); they existed for the lock test, which
 * is how a test came to assert a size against a decision that had declined to size anything.
 *
 * Returning the decision keeps `ok` and the sizing inseparable at every call site. It also drops
 * the import-time /proc/meminfo read: importing the lock helpers no longer probes host memory as a
 * side effect, so the probe happens when someone asks, not when someone imports.
 */
export function resolveHeavyGate() {
  return decideHeavyGate({ cpuCount: cpus().length || 1 });
}

/** t-6a9bc4: at most one full-suite gate host-wide (verify_task + agent contracts share this entrypoint). */
export const VERIFY_FULL_LOCK_PATH = process.env.TACHYON_VERIFY_FULL_LOCK_PATH || path.join(tmpdir(), "tachyon-verify-full.lock");

/**
 * t-dcd8eb — the non-test gates this command owns, in cheapest-first order so a 100ms failure never
 * waits behind a 19s one. Exported because `test/unit/ciWorkflowSingleSource.test.ts` asserts the CI
 * workflow delegates to this command instead of re-listing these steps: two hand-maintained lists is
 * how they came to disagree in the first place.
 */
/**
 * t-62cc44 — `check:source-diffable` goes FIRST: it is the cheapest of the three (a byte scan, no
 * compile) and the failure it catches used to be the most expensive to find. As a vitest test it
 * could only fail after the build, so three raw NUL separators — two people, one shared idiom of a
 * template literal joining ids for a `Set` key — each cost a whole run plus a lock wait. Moving it
 * ahead of the compile IS the change; the rule itself is unchanged and still lives in one place,
 * `scripts/check-source-diffable.mjs`, which the test imports rather than restates.
 */
export const STATIC_GATES = ["check:source-diffable", "check:engine-boundary", "typecheck"];

function gitOutput(args, cwd = process.cwd()) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The suite's own definition — true whatever it happens to import. */
const BROWSER_SUITE_OWN = Object.freeze(["test/browser/", "vitest.browser.config.ts"]);

/**
 * t-e2c8a2 — the trigger set is DERIVED from what the browser suite actually reads, never written
 * out here.
 *
 * The gate this replaces triggered on `src/webview/` alone, which was the ONE input someone
 * remembered when t-6e929b wrote it. Measured against the suite: it also imports `src/sidebar`
 * (six files), `src/agents`, `src/cockpit` and `scripts/webview-preview` — and, worst of all, it
 * did not trigger on `test/browser/` itself, so the person writing a browser test was the one
 * person guaranteed not to run it. A hand-written list is what this repo has watched drift before
 * (SDD 485 D15: nine entries copied against a launcher that had grown to twelve), so this walks
 * the suite and resolves every import that escapes it.
 *
 * Granularity is two path segments (`src/sidebar`, not `src/sidebar/cardTemplate.ts`): a browser
 * test importing one file from a directory is evidence that the directory is rendered, not that
 * the single file is. Resolution is per-file because the suite is two levels deep in places.
 */
export function browserSuiteRoots({ cwd = process.cwd() } = {}) {
  const roots = new Set(BROWSER_SUITE_OWN);
  const suiteDir = path.join(cwd, "test", "browser");
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(?:m?ts|tsx|m?js)$/.test(entry.name)) continue;
      let source;
      try { source = readFileSync(full, "utf8"); } catch { continue; }
      for (const [, spec] of source.matchAll(/\bfrom\s+"(\.\.?\/[^"]+)"/g)) {
        const resolved = path.relative(cwd, path.resolve(path.dirname(full), spec));
        if (resolved.startsWith("..") || path.isAbsolute(resolved)) continue;
        const segments = resolved.split(path.sep);
        if (segments.length < 2) continue;
        const root = `${segments.slice(0, 2).join("/")}/`;
        if (!root.startsWith("test/browser/")) roots.add(root);
      }
    }
  };
  walk(suiteDir);
  return [...roots].sort();
}

/** t-6e929b — browser layout coverage follows changes to what the browser suite reads. */
export function browserGateDecision({ cwd = process.cwd() } = {}) {
  const roots = browserSuiteRoots({ cwd });
  try {
    const head = gitOutput(["rev-parse", "HEAD"], cwd);
    const branch = gitOutput(["branch", "--show-current"], cwd);
    let base;
    if (branch === "main") {
      base = gitOutput(["rev-parse", "HEAD^"], cwd);
    } else {
      base = gitOutput(["merge-base", "HEAD", "main"], cwd);
    }
    const tracked = [
      gitOutput(["diff", "--name-only", base, "HEAD", "--"], cwd),
      gitOutput(["diff", "--name-only", "--"], cwd),
      gitOutput(["diff", "--cached", "--name-only", "HEAD", "--"], cwd),
    ].flatMap((output) => output.split("\n").filter(Boolean));
    // Untracked scanned over the SAME roots as tracked: a brand-new browser test is untracked by
    // definition, and scanning only one root was how the previous shape missed it twice over.
    const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "--", ...roots], cwd)
      .split("\n").filter(Boolean);
    const changedPaths = [...new Set([...tracked, ...untracked])];
    const webviewPaths = changedPaths.filter((file) => roots.some((root) => file.startsWith(root) || file === root));
    return { run: webviewPaths.length > 0, changedPaths, webviewPaths, roots, base, head };
  } catch {
    // verify:full also has unit-test fixtures outside Git. They have no product diff, so say exactly
    // why browser coverage is absent instead of pretending the decision was evaluated.
    return { run: false, changedPaths: [], webviewPaths: [], roots, reason: "no Git diff available" };
  }
}

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

/** t-eccb00: summarize native Vitest skips; never rewrite statuses or the process exit code. */
export function summarizeUnavailableCoverage(report) {
  const counts = new Map();
  for (const file of Array.isArray(report?.testResults) ? report.testResults : []) {
    for (const assertion of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      if (assertion?.status !== "skipped") continue;
      const runtime = assertion?.meta?.optionalRuntimeAuthUnavailable;
      if (typeof runtime !== "string") continue;
      const reason = `optional ${runtime} credential unavailable`;
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts].map(([reason, count]) => ({ reason, count }));
}

export function formatSuccess(report) {
  const count = summarizeReport(report);
  const testParts = [`${count.passed} passed`];
  if (count.failed) testParts.push(`${count.failed} failed`);
  if (count.skipped) testParts.push(`${count.skipped} skipped`);
  if (count.todo) testParts.push(`${count.todo} todo`);
  const lines = [
    "verify:full:quiet passed",
    `Files: ${count.passedFiles} passed (${count.files})`,
    `Tests: ${testParts.join(" | ")} (${count.total})`,
  ];
  const unavailable = summarizeUnavailableCoverage(report);
  if (unavailable.length) {
    lines.push("Coverage unavailable (native test skips):");
    for (const item of unavailable) lines.push(`- ${item.count}: ${item.reason}`);
  }
  return lines.join("\n");
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

/**
 * t-5d0e9d — may this run stand on a green already filed for the identical tree?
 *
 * Consulted BEFORE the lock on purpose, and that ordering is most of the value. The redundant runs
 * this removes are exactly the ones that CONTEND: an agent verifies, the coordinator fast-forwards
 * and verifies the identical tree, then the pre-push gate verifies it a third time. Taking the lock
 * only to discover the answer was already on file would still serialize all three behind each other.
 *
 * It also reaches all three callers without touching the pre-push hook, which ships from a pinned
 * external plugin and is integrity-checked: that gate resolves `npm run verify:full`, so making the
 * COMMAND cheap is what makes the gate cheap.
 */
export function decideReuse({ env = process.env, now = () => Date.now() } = {}) {
  const { fingerprint } = verifierFingerprint({ command: "verify:full", gates: STATIC_GATES });
  const maxAgeMs = Number(env.TACHYON_VERIFY_MAX_AGE_MS);
  return reuseDecision({
    tree: verifiableTree(),
    fingerprint,
    force: env.TACHYON_VERIFY_FORCE === "1",
    now,
    ...(Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? { maxAgeMs } : {}),
  });
}

export async function main() {
  // t-5d0e9d — an identical tree that already passed, in this environment, recently, does not need to
  // pass again. Every other case runs the suite: the decision is fail-closed and never consults a
  // commit sha, a commit message, or an agent's claim about what it ran.
  const reuse = decideReuse();
  if (reuse.reuse) {
    process.stdout.write(`verify:full reused: ${reuse.reason}\n`);
    process.stdout.write(`  ${reuse.record.summary ?? "no summary recorded"} — set TACHYON_VERIFY_FORCE=1 to run it anyway\n`);
    return 0;
  }
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
  const gate = resolveHeavyGate();
  if (!gate.ok) {
    process.stderr.write(`${gate.reason}\n`);
    lock?.release();
    return 75;
  }
  const workers = gate.workers;
  process.stderr.write(`[verify:full] ${gate.reason}\n`);

  const root = mkdtempSync(path.join(tmpdir(), "tachyon-verify-full-"));
  chmodSync(root, 0o700);
  const staticLog = path.join(root, "static.log");
  const buildLog = path.join(root, "build.log");
  const testLog = path.join(root, "vitest.log");
  const reportFile = path.join(root, "vitest-report.json");
  const active = { child: undefined };
  let receivedSignal;
  const forward = (signal) => { receivedSignal = signal; active.child?.kill(signal); };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    // t-dcd8eb — STATIC gates first, cheapest-first, before spending the build+suite.
    //
    // These used to live only in .github/workflows/ci.yml, so `verify:full` was NOT a superset of CI:
    // it ran build+tests and skipped both of these. With Actions out of credit (t-815159) nothing ran
    // them at all, and the engine/UI boundary had been red on main since 3aa19029 with no signal. The
    // pre-push gate resolves this same command, so a push to the trunk was not typechecked either --
    // even though the regression that motivated the gate (t-381750) was a TS2345.
    //
    // They belong HERE, not in the workflow, so that one command is the single source of truth and CI
    // merely calls it. `npm run typecheck` stays available on its own as the fast standalone check.
    for (const gate of STATIC_GATES) {
      const result = await runChild("npm", ["run", "--silent", gate], staticLog, active);
      if (result.code !== 0 || result.signal || receivedSignal) {
        process.stderr.write(`${formatFailure({ phase: gate, fallback: await readTail(staticLog), logDir: root })}\n`);
        return receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : result.code || 1;
      }
    }
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
    const reportSummary = report ? summarizeReport(report) : undefined;
    const reportFailed = report?.success === false || (reportSummary?.failed ?? 0) > 0 || (reportSummary?.failedFiles ?? 0) > 0;
    if (tests.code !== 0 || tests.signal || receivedSignal || !report || reportFailed) {
      process.stderr.write(`${formatFailure({ phase: "tests", report, fallback: await readTail(testLog), logDir: root })}\n`);
      return receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : tests.code || 1;
    }
    const browserDecision = browserGateDecision();
    let browserSummary;
    if (browserDecision.run) {
      const browserLog = path.join(root, "browser.log");
      const browserReportFile = path.join(root, "browser-report.json");
      const browserTests = await runChild(process.execPath,
        [vitestEntry, "run", "--config", "vitest.browser.config.ts", "--reporter=json", `--outputFile=${browserReportFile}`, "--silent=passed-only"], browserLog, active);
      let browserReport;
      try { browserReport = JSON.parse(readFileSync(browserReportFile, "utf8")); } catch { browserReport = undefined; }
      const browserCount = browserReport ? summarizeReport(browserReport) : undefined;
      const browserFailed = browserReport?.success === false || (browserCount?.failed ?? 0) > 0 || (browserCount?.failedFiles ?? 0) > 0;
      if (browserTests.code !== 0 || browserTests.signal || receivedSignal || !browserReport || browserFailed) {
        process.stderr.write(`${formatFailure({ phase: "browser tests", report: browserReport, fallback: await readTail(browserLog), logDir: root })}\n`);
        return receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : browserTests.code || 1;
      }
      browserSummary = `${browserCount.total} browser tests (${browserDecision.webviewPaths.length} change${browserDecision.webviewPaths.length === 1 ? "" : "s"} under ${browserDecision.roots.length} browser-suite root${browserDecision.roots.length === 1 ? "" : "s"})`;
    } else {
      // t-e2c8a2 — the skip names the derived roots, not "src/webview": a reader who edited
      // `src/sidebar` and saw "no src/webview change" had no way to tell whether the gate had
      // considered their diff and declined, or never looked at it. It never looked.
      browserSummary = browserDecision.reason
        ? `0 browser tests (${browserDecision.reason})`
        : `0 browser tests (no change under ${browserDecision.roots.join(", ")})`;
    }
    process.stdout.write(`${formatSuccess(report)}\n${browserSummary}\n`);
    // t-47cc91 — file the green under the TREE it covered, so "the tree you land is the tree you
    // verified" becomes a lookup instead of something the operator has to still remember. Recorded
    // only on the success path: a red or aborted run must never leave a proof behind.
    const count = summarizeReport(report);
    const filed = recordVerification({
      command: "verify:full",
      // t-5d0e9d — file WHICH verifier and environment produced this green, so a later run can tell
      // whether the record still applies to it instead of assuming it does.
      fingerprint: verifierFingerprint({ command: "verify:full", gates: STATIC_GATES }).fingerprint,
      summary: `${count.files} files, ${count.passed} passed`,
    });
    process.stdout.write(
      filed.recorded
        ? `verified tree ${filed.record.tree.slice(0, 12)} recorded\n`
        : `no verification record written: ${filed.reason}\n`,
    );
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
