import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const INVARIANT_DIRECTORY = path.join("test", "product-invariants");
const INVARIANT_REGISTRY = path.join(INVARIANT_DIRECTORY, "registry.json");
const GOVERNANCE_REGISTRY = path.join("docs", "architecture", "product-invariant-testing.md");
const INVARIANT_CONFIG = "vitest.product-invariants.config.ts";
const INVARIANT_ASSERTION_SETUP = path.join(INVARIANT_DIRECTORY, "setup.ts");
const EXPECTED_ASSERTION_SETUP = [
  'import { beforeEach, expect } from "vitest";',
  "",
  "// Gate-owned runtime guard: every Product Invariant test must execute at least one assertion.",
  "beforeEach(() => {",
  "  expect.hasAssertions();",
  "});",
  "",
].join("\n");
const EXPECTED_INVARIANT_CONFIG = [
  'import { defineConfig } from "vitest/config";',
  'import path from "node:path";',
  "",
  "export default defineConfig({",
  "  resolve: { alias: { vscode: path.resolve(__dirname, \"test/mocks/vscode.ts\") } },",
  "  test: {",
  '    include: ["test/product-invariants/**/*.test.ts"],',
  '    setupFiles: ["test/product-invariants/setup.ts"],',
  '    environment: "node",',
  "    testTimeout: 30_000,",
  "    hookTimeout: 30_000,",
  "  },",
  "});",
  "",
].join("\n");
const INVARIANT_FILE = /^(PI-\d{3})-(.+)\.test\.ts$/;
const REGISTERED_INVARIANT_FILE = /^test\/product-invariants\/(PI-\d{3})-([^/]+)\.test\.ts$/;
const REQUIRED_COUNTERS = [
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
  "numPendingTestSuites",
];

function canonicalPath(root, value) {
  const resolved = path.normalize(path.isAbsolute(value) ? value : path.resolve(root, value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function formatErrorList(errors) {
  return ["Product Invariant gate failed:", ...errors.map((error) => `- ${error}`)].join("\n");
}

function assertionText(assertion) {
  return [
    assertion?.fullName,
    assertion?.title,
    ...(Array.isArray(assertion?.ancestorTitles) ? assertion.ancestorTitles : []),
  ].filter((value) => typeof value === "string").join("\n");
}

function mentionsInvariantId(assertion, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Z0-9-])${escaped}(?![A-Z0-9-])`, "i").test(assertionText(assertion));
}

function assertRegularContainedSource(root, source, prefix) {
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch (error) {
    throw new Error(`${prefix}.source cannot resolve workspace root: ${error.message}`);
  }

  let current = canonicalRoot;
  const segments = source.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw new Error(`${prefix}.source does not exist as a regular workspace file: ${source} (${error.message})`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${prefix}.source must not contain symbolic links: ${source}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${prefix}.source has a non-directory parent: ${source}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`${prefix}.source must be a regular workspace file: ${source}`);
    }
  }
}

export function discoverProductInvariants(root = process.cwd()) {
  const directory = path.resolve(root, INVARIANT_DIRECTORY);
  let rootEntries;
  try {
    rootEntries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const testEntries = [];
  const visit = (entries, relativeDirectory) => {
    for (const entry of entries) {
      const relativeName = path.join(relativeDirectory, entry.name);
      if (entry.name.endsWith(".test.ts")) {
        testEntries.push({ entry, relativeName });
      } else if (entry.isDirectory()) {
        visit(readdirSync(path.join(directory, relativeName), { withFileTypes: true }), relativeName);
      }
    }
  };
  visit(rootEntries, "");

  for (const { entry, relativeName } of testEntries) {
    if (!entry.isFile()) {
      throw new Error(`${path.join(INVARIANT_DIRECTORY, relativeName)} must be a regular Product Invariant test file`);
    }
    if (relativeName !== entry.name || !INVARIANT_FILE.test(entry.name)) {
      throw new Error(`${path.join(INVARIANT_DIRECTORY, relativeName)} must match PI-NNN-*.test.ts at the directory root`);
    }
  }

  return testEntries
    .map(({ entry }) => {
      const match = INVARIANT_FILE.exec(entry.name);
      return {
        id: match[1],
        file: path.join(INVARIANT_DIRECTORY, entry.name),
        absolutePath: path.join(directory, entry.name),
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function parseProductInvariantRegistry(raw, root = process.cwd()) {
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Product Invariant registry is not valid JSON: ${error.message}`);
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("Product Invariant registry must be an object");
  }
  if (registry.schemaVersion !== 1) {
    throw new Error("Product Invariant registry must declare schemaVersion 1");
  }
  if (!Array.isArray(registry.active)) {
    throw new Error("Product Invariant registry must contain an active list");
  }

  const ids = new Set();
  const files = new Set();
  return registry.active.map((entry, index) => {
    const prefix = `Product Invariant registry active[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${prefix} must be an object`);
    }
    if (typeof entry.id !== "string" || !/^PI-\d{3}$/.test(entry.id)) {
      throw new Error(`${prefix}.id must match PI-NNN`);
    }
    if (typeof entry.file !== "string") {
      throw new Error(`${prefix}.file must be a test path`);
    }
    const fileMatch = REGISTERED_INVARIANT_FILE.exec(entry.file);
    if (!fileMatch || fileMatch[1] !== entry.id) {
      throw new Error(`${prefix}.file must match test/product-invariants/${entry.id}-*.test.ts`);
    }
    if (typeof entry.source !== "string" || entry.source.length === 0
      || entry.source.startsWith("/") || /^[A-Za-z]:/.test(entry.source) || entry.source.includes("\\")
      || /[\u0000-\u001f\u007f-\u009f]/u.test(entry.source)
      || entry.source.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`${prefix}.source must be a non-empty workspace-relative POSIX path`);
    }
    if (ids.has(entry.id)) throw new Error(`${prefix}.id duplicates ${entry.id}`);
    if (files.has(entry.file)) throw new Error(`${prefix}.file duplicates ${entry.file}`);
    assertRegularContainedSource(root, entry.source, prefix);
    ids.add(entry.id);
    files.add(entry.file);
    return {
      id: entry.id,
      file: entry.file,
      source: entry.source,
      absolutePath: path.resolve(root, ...entry.file.split("/")),
    };
  });
}

export function loadProductInvariantRegistry(root = process.cwd()) {
  const registryPath = path.resolve(root, INVARIANT_REGISTRY);
  let raw;
  try {
    raw = readFileSync(registryPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read Product Invariant registry ${INVARIANT_REGISTRY}: ${error.message}`);
  }
  return parseProductInvariantRegistry(raw, root);
}

export function parseProductInvariantGovernanceRegistry(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Product Invariant governance registry must be non-empty Markdown");
  }

  const headings = [...raw.matchAll(/^### (PI-\d{3})\b[^\n]*$/gm)];
  const active = [];
  const ids = new Set();
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const id = heading[1];
    const start = heading.index ?? 0;
    const end = headings[index + 1]?.index ?? raw.length;
    const section = raw.slice(start, end);
    const status = /^- \*\*Status \/ owner:\*\*\s*([^/\n.]+)\s*\//m.exec(section)?.[1]?.trim();
    if (status !== "active") continue;
    if (ids.has(id)) throw new Error(`Product Invariant governance registry duplicates active ${id}`);

    const source = /^- \*\*Source:\*\*\s*`([^`]+)`/m.exec(section)?.[1];
    const file = /^- \*\*Executable evidence:\*\*\s*`([^`]+)`/m.exec(section)?.[1];
    if (!source) throw new Error(`${id} active governance entry is missing its durable Source path`);
    if (!file) throw new Error(`${id} active governance entry is missing its Executable evidence path`);
    if (!REGISTERED_INVARIANT_FILE.test(file)) {
      throw new Error(`${id} governance Executable evidence must be a canonical Product Invariant test path`);
    }
    ids.add(id);
    active.push({ id, file, source });
  }
  return active;
}

export function loadProductInvariantGovernanceRegistry(root = process.cwd()) {
  const registryPath = path.resolve(root, GOVERNANCE_REGISTRY);
  let raw;
  try {
    raw = readFileSync(registryPath, "utf8");
  } catch (error) {
    throw new Error(`cannot read Product Invariant governance registry ${GOVERNANCE_REGISTRY}: ${error.message}`);
  }
  return parseProductInvariantGovernanceRegistry(raw);
}

export function validateProductInvariantHarness(root = process.cwd()) {
  const expectedFiles = [
    { file: INVARIANT_ASSERTION_SETUP.replaceAll("\\", "/"), expected: EXPECTED_ASSERTION_SETUP },
    { file: INVARIANT_CONFIG, expected: EXPECTED_INVARIANT_CONFIG },
  ];
  const errors = [];
  for (const { file, expected } of expectedFiles) {
    const absolute = path.resolve(root, ...file.split("/"));
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push(`${file} must be the gate-owned regular assertion harness file`);
      } else if (readFileSync(absolute, "utf8") !== expected) {
        errors.push(`${file} differs from the gate-owned assertion harness`);
      }
    } catch (error) {
      errors.push(`cannot read Product Invariant assertion harness ${file}: ${error.message}`);
    }
  }
  return errors;
}

export function validateProductInvariantInventory(registered, discovered, governed) {
  const errors = [];
  if (!Array.isArray(registered) || registered.length === 0) {
    errors.push(`no active Product Invariant is registered in ${INVARIANT_REGISTRY}`);
    return errors;
  }
  if (!Array.isArray(governed) || governed.length === 0) {
    errors.push(`no active Product Invariant is registered in ${GOVERNANCE_REGISTRY}`);
    return errors;
  }

  const discoveredByFile = new Map(discovered.map((invariant) => [invariant.file.replaceAll("\\", "/"), invariant]));
  const discoveredIdCounts = new Map();
  for (const invariant of discovered) {
    discoveredIdCounts.set(invariant.id, (discoveredIdCounts.get(invariant.id) ?? 0) + 1);
  }
  for (const [id, count] of discoveredIdCounts) {
    if (count > 1) errors.push(`${id} is declared by ${count} test files; each Product Invariant ID must be unique`);
  }

  const registeredByFile = new Map(registered.map((invariant) => [invariant.file, invariant]));
  for (const invariant of registered) {
    if (!discoveredByFile.has(invariant.file)) {
      errors.push(`${invariant.id} is active in ${INVARIANT_REGISTRY} but its test file is missing: ${invariant.file}`);
    }
  }
  for (const invariant of discovered) {
    const normalizedFile = invariant.file.replaceAll("\\", "/");
    const active = registeredByFile.get(normalizedFile);
    if (!active) {
      errors.push(`${invariant.id} test file exists but is not active in ${INVARIANT_REGISTRY}: ${normalizedFile}`);
    } else if (active.id !== invariant.id) {
      errors.push(`${normalizedFile} identifies ${invariant.id} but the active registry identifies ${active.id}`);
    }
  }

  const governedById = new Map(governed.map((invariant) => [invariant.id, invariant]));
  const registeredById = new Map(registered.map((invariant) => [invariant.id, invariant]));
  for (const invariant of registered) {
    const governance = governedById.get(invariant.id);
    if (!governance) {
      errors.push(`${invariant.id} is active in ${INVARIANT_REGISTRY} but missing from ${GOVERNANCE_REGISTRY}`);
      continue;
    }
    if (governance.file !== invariant.file) {
      errors.push(`${invariant.id} evidence file differs between machine and governance registries: ${invariant.file} != ${governance.file}`);
    }
    if (governance.source !== invariant.source) {
      errors.push(`${invariant.id} durable source differs between machine and governance registries: ${invariant.source} != ${governance.source}`);
    }
  }
  for (const invariant of governed) {
    if (!registeredById.has(invariant.id)) {
      errors.push(`${invariant.id} is active in ${GOVERNANCE_REGISTRY} but missing from ${INVARIANT_REGISTRY}`);
    }
  }
  return errors;
}

export function parseProductInvariantReport(raw) {
  let report;
  try {
    report = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Vitest JSON report is not valid JSON: ${error.message}`);
  }

  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Vitest JSON report must be an object");
  }
  if (report.success !== true && report.success !== false) {
    throw new Error("Vitest JSON report is missing boolean success");
  }
  for (const counter of REQUIRED_COUNTERS) {
    if (!Number.isInteger(report[counter]) || report[counter] < 0) {
      throw new Error(`Vitest JSON report has invalid ${counter}`);
    }
  }
  if (!Array.isArray(report.testResults)) {
    throw new Error("Vitest JSON report is missing testResults");
  }
  for (const result of report.testResults) {
    if (!result || typeof result !== "object" || typeof result.name !== "string"
      || typeof result.status !== "string" || !Array.isArray(result.assertionResults)) {
      throw new Error("Vitest JSON report contains an invalid test result");
    }
    for (const assertion of result.assertionResults) {
      if (!assertion || typeof assertion !== "object" || typeof assertion.status !== "string") {
        throw new Error("Vitest JSON report contains an invalid assertion result");
      }
    }
  }
  const assertions = report.testResults.flatMap((result) => result.assertionResults);
  const statusCount = (statuses) => assertions.filter((assertion) => statuses.includes(assertion.status.toLowerCase())).length;
  if (report.numTotalTests !== assertions.length) {
    throw new Error(`Vitest JSON report counters disagree: numTotalTests=${report.numTotalTests}, assertions=${assertions.length}`);
  }
  const expectedCounters = {
    numPassedTests: statusCount(["passed"]),
    numFailedTests: statusCount(["failed"]),
    numPendingTests: statusCount(["pending", "skipped", "disabled"]),
    numTodoTests: statusCount(["todo"]),
  };
  for (const [counter, observed] of Object.entries(expectedCounters)) {
    if (report[counter] !== observed) {
      throw new Error(`Vitest JSON report counters disagree: ${counter}=${report[counter]}, assertions=${observed}`);
    }
  }
  if (Object.values(expectedCounters).reduce((sum, count) => sum + count, 0) !== assertions.length) {
    throw new Error("Vitest JSON report contains an assertion with an unknown status");
  }
  return report;
}

export function validateProductInvariantReport(report, invariants, root = process.cwd()) {
  const errors = [];
  if (!Array.isArray(invariants) || invariants.length === 0) {
    errors.push(`no active Product Invariant is registered in ${INVARIANT_REGISTRY}`);
    return errors;
  }

  const ids = new Map();
  for (const invariant of invariants) {
    ids.set(invariant.id, (ids.get(invariant.id) ?? 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) errors.push(`${id} is declared by ${count} files; each Product Invariant ID must be unique`);
  }

  if (report.success !== true) errors.push("Vitest did not report success");
  if (report.numTotalTests === 0) errors.push("Vitest reported no active Product Invariant tests");
  if (report.numFailedTests > 0) errors.push(`Vitest reported ${report.numFailedTests} failed test(s)`);
  if (report.numPendingTests > 0) errors.push(`Vitest reported ${report.numPendingTests} skipped or pending test(s)`);
  if (report.numTodoTests > 0) errors.push(`Vitest reported ${report.numTodoTests} todo test(s)`);
  if (report.numPendingTestSuites > 0) errors.push(`Vitest reported ${report.numPendingTestSuites} pending test suite(s)`);

  const resultsByPath = new Map();
  for (const result of report.testResults) {
    const resultPath = canonicalPath(root, result.name);
    const existing = resultsByPath.get(resultPath) ?? [];
    existing.push(result);
    resultsByPath.set(resultPath, existing);

    if (result.status.toLowerCase() !== "passed") {
      errors.push(`${result.name} has non-passing file status ${result.status}`);
    }
    for (const assertion of result.assertionResults) {
      if (assertion.status.toLowerCase() !== "passed") {
        const label = assertion.fullName ?? assertion.title ?? "unnamed assertion";
        errors.push(`${result.name}: ${label} has forbidden status ${assertion.status}`);
      }
    }
  }

  for (const invariant of invariants) {
    const results = resultsByPath.get(canonicalPath(root, invariant.absolutePath)) ?? [];
    if (results.length === 0) {
      errors.push(`${invariant.id} expected file is absent from the Vitest report: ${invariant.file}`);
      continue;
    }
    const assertions = results.flatMap((result) => result.assertionResults);
    const observed = assertions.filter((assertion) => mentionsInvariantId(assertion, invariant.id));
    if (observed.length === 0) {
      errors.push(`${invariant.id} was not observed in any assertion name for ${invariant.file}`);
    } else if (!observed.some((assertion) => assertion.status.toLowerCase() === "passed")) {
      errors.push(`${invariant.id} was observed but did not pass in ${invariant.file}`);
    }
  }

  return errors;
}

export function productInvariantVitestArgs(reportFile) {
  return [
    "run",
    INVARIANT_DIRECTORY,
    `--config=${INVARIANT_CONFIG}`,
    "--allowOnly=false",
    "--reporter=json",
    `--outputFile=${reportFile}`,
  ];
}

export function main(root = process.cwd()) {
  let invariants;
  let discovered;
  let governed;
  try {
    invariants = loadProductInvariantRegistry(root);
    discovered = discoverProductInvariants(root);
    governed = loadProductInvariantGovernanceRegistry(root);
  } catch (error) {
    process.stderr.write(`${formatErrorList([error.message])}\n`);
    return 1;
  }
  const inventoryErrors = [
    ...validateProductInvariantInventory(invariants, discovered, governed),
    ...validateProductInvariantHarness(root),
  ];
  if (inventoryErrors.length > 0) {
    process.stderr.write(`${formatErrorList(inventoryErrors)}\n`);
    return 1;
  }

  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "tachyon-product-invariants-"));
  chmodSync(temporaryDirectory, 0o700);
  const reportFile = path.join(temporaryDirectory, "vitest-report.json");
  try {
    const vitestEntry = path.resolve(root, "node_modules", "vitest", "vitest.mjs");
    const child = spawnSync(process.execPath, [vitestEntry, ...productInvariantVitestArgs(reportFile)], {
      cwd: root,
      stdio: "inherit",
    });

    if (child.error) {
      process.stderr.write(`${formatErrorList([`unable to run local Vitest: ${child.error.message}`])}\n`);
      return 1;
    }
    if (child.status !== 0) {
      process.stderr.write(`${formatErrorList([
        child.signal ? `Vitest terminated by ${child.signal}` : `Vitest exited with status ${child.status ?? "unknown"}`,
      ])}\n`);
      return typeof child.status === "number" && child.status > 0 ? child.status : 1;
    }

    let report;
    try {
      report = parseProductInvariantReport(readFileSync(reportFile, "utf8"));
    } catch (error) {
      process.stderr.write(`${formatErrorList([error.message])}\n`);
      return 1;
    }
    const errors = validateProductInvariantReport(report, invariants, root);
    if (errors.length > 0) {
      process.stderr.write(`${formatErrorList(errors)}\n`);
      return 1;
    }

    process.stdout.write(`Product Invariant gate passed: ${invariants.length} invariant(s), ${report.numPassedTests} test(s).\n`);
    return 0;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
