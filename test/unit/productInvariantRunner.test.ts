import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- importing the owned .mjs runner directly is the behavior under test.
import { discoverProductInvariants, parseProductInvariantGovernanceRegistry, parseProductInvariantRegistry, parseProductInvariantReport, productInvariantVitestArgs, validateProductInvariantHarness, validateProductInvariantInventory, validateProductInvariantReport } from "../../scripts/run-product-invariants.mjs";

const roots = new Set<string>();

function workspace(files = ["PI-001-owned-promise.test.ts"]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-runner-"));
  roots.add(root);
  const directory = path.join(root, "test", "product-invariants");
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(
      path.join(directory, file),
      "import { beforeEach, expect } from \"vitest\";\nbeforeEach(() => { expect.hasAssertions(); });\n",
      "utf8",
    );
  }
  return root;
}

function reportFor(invariants: Array<{ id: string; absolutePath: string }>) {
  return {
    numTotalTestSuites: invariants.length,
    numPassedTestSuites: invariants.length,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: invariants.length,
    numPassedTests: invariants.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: invariants.map((invariant) => ({
      name: invariant.absolutePath,
      status: "passed",
      assertionResults: [{
        status: "passed",
        fullName: `${invariant.id}: stable product promise`,
        title: "stable product promise",
        ancestorTitles: [`${invariant.id}: boundary`],
      }],
    })),
  };
}

function registryFor(files: string[], root: string) {
  const source = path.join(root, "docs", "specs", "383-primer-project-guidance-boundary", "spec.md");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  if (!fs.existsSync(source)) fs.writeFileSync(source, "# fixture source\n", "utf8");
  return parseProductInvariantRegistry(JSON.stringify({
    schemaVersion: 1,
    active: files.map((file) => ({
      id: /^PI-\d{3}/.exec(path.basename(file))?.[0],
      file,
      source: "docs/specs/383-primer-project-guidance-boundary/spec.md",
    })),
  }), root);
}

function governanceFor(files: string[]) {
  return parseProductInvariantGovernanceRegistry(files.map((file) => {
    const id = /^PI-\d{3}/.exec(path.basename(file))?.[0];
    return [
      `### ${id} — fixture`,
      "",
      "- **Status / owner:** active / fixture maintainers.",
      "- **Source:** `docs/specs/383-primer-project-guidance-boundary/spec.md`.",
      `- **Executable evidence:** \`${file}\` via the fixture gate.`,
      "",
    ].join("\n");
  }).join("\n"));
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("Product Invariant runner", () => {
  it("discovers only sorted PI-NNN test files and derives their IDs", () => {
    const root = workspace([
      "PI-002-second.test.ts",
      "PI-001-first.test.ts",
      "README.md",
    ]);

    expect(discoverProductInvariants(root).map((entry: { id: string; file: string }) => ({
      id: entry.id,
      file: entry.file.replaceAll("\\", "/"),
    }))).toEqual([
      { id: "PI-001", file: "test/product-invariants/PI-001-first.test.ts" },
      { id: "PI-002", file: "test/product-invariants/PI-002-second.test.ts" },
    ]);
  });

  it("fails discovery for any non-canonical or non-regular *.test.ts entry", () => {
    const malformedRoot = workspace(["PI-001-valid.test.ts", "PI-01-malformed.test.ts"]);
    expect(() => discoverProductInvariants(malformedRoot)).toThrow(
      /PI-01-malformed\.test\.ts must match PI-NNN-\*\.test\.ts at the directory root/,
    );

    const directoryRoot = workspace(["PI-001-valid.test.ts"]);
    fs.mkdirSync(path.join(directoryRoot, "test", "product-invariants", "PI-002-directory.test.ts"));
    expect(() => discoverProductInvariants(directoryRoot)).toThrow(/must be a regular Product Invariant test file/);

    const nestedRoot = workspace(["PI-001-valid.test.ts"]);
    const nested = path.join(nestedRoot, "test", "product-invariants", "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "PI-002-hidden.test.ts"), "// fixture\n", "utf8");
    expect(() => discoverProductInvariants(nestedRoot)).toThrow(/PI-002-hidden\.test\.ts.*at the directory root/);
  });

  it("accepts a valid report only when every discovered ID is observed and passed", () => {
    const root = workspace();
    const invariants = discoverProductInvariants(root);
    const report = parseProductInvariantReport(JSON.stringify(reportFor(invariants)));

    expect(validateProductInvariantReport(report, invariants, root)).toEqual([]);
  });

  it("parses the machine-readable active registry and rejects malformed ownership records", () => {
    const root = workspace();
    expect(registryFor(["test/product-invariants/PI-001-owned-promise.test.ts"], root)).toEqual([{
      id: "PI-001",
      file: "test/product-invariants/PI-001-owned-promise.test.ts",
      source: "docs/specs/383-primer-project-guidance-boundary/spec.md",
      absolutePath: path.join(root, "test", "product-invariants", "PI-001-owned-promise.test.ts"),
    }]);
    expect(() => parseProductInvariantRegistry("{}", root)).toThrow(/schemaVersion 1/);
    expect(() => parseProductInvariantRegistry(JSON.stringify({
      schemaVersion: 1,
      active: [{
        id: "PI-001",
        file: "test/product-invariants/PI-002-wrong-id.test.ts",
        source: "docs/spec.md",
      }],
    }), root)).toThrow(/PI-001-\*\.test\.ts/);
    expect(() => parseProductInvariantRegistry(JSON.stringify({
      schemaVersion: 1,
      active: [{
        id: "PI-001",
        file: "test/product-invariants/PI-001-owned-promise.test.ts",
        source: "../outside.md",
      }],
    }), root)).toThrow(/workspace-relative POSIX path/);
  });

  it("requires every registered source to be a contained regular file without symlinks", () => {
    const root = workspace();
    const parseSource = (source: string) => parseProductInvariantRegistry(JSON.stringify({
      schemaVersion: 1,
      active: [{
        id: "PI-001",
        file: "test/product-invariants/PI-001-owned-promise.test.ts",
        source,
      }],
    }), root);

    expect(() => parseSource("docs/missing.md")).toThrow(/does not exist as a regular workspace file/);
    fs.mkdirSync(path.join(root, "docs", "directory"), { recursive: true });
    expect(() => parseSource("docs/directory")).toThrow(/must be a regular workspace file/);

    if (process.platform !== "win32") {
      const outside = workspace([]);
      fs.writeFileSync(path.join(outside, "source.md"), "outside\n", "utf8");
      fs.symlinkSync(outside, path.join(root, "linked-docs"), "dir");
      expect(() => parseSource("linked-docs/source.md")).toThrow(/must not contain symbolic links/);
    }
  });

  it("fails when an active registered PI has no test file even while another PI exists", () => {
    const root = workspace(["PI-001-present.test.ts"]);
    const discovered = discoverProductInvariants(root);
    const registered = registryFor([
      "test/product-invariants/PI-001-present.test.ts",
      "test/product-invariants/PI-002-missing.test.ts",
    ], root);

    expect(validateProductInvariantInventory(registered, discovered, governanceFor([
      "test/product-invariants/PI-001-present.test.ts",
      "test/product-invariants/PI-002-missing.test.ts",
    ]))).toContain(
      "PI-002 is active in test/product-invariants/registry.json but its test file is missing: test/product-invariants/PI-002-missing.test.ts",
    );
  });

  it("fails when a PI test file is present but omitted from the active registry", () => {
    const root = workspace(["PI-001-active.test.ts", "PI-002-unregistered.test.ts"]);
    const registered = registryFor(["test/product-invariants/PI-001-active.test.ts"], root);

    expect(validateProductInvariantInventory(
      registered,
      discoverProductInvariants(root),
      governanceFor(["test/product-invariants/PI-001-active.test.ts"]),
    )).toContain(
      "PI-002 test file exists but is not active in test/product-invariants/registry.json: test/product-invariants/PI-002-unregistered.test.ts",
    );
  });

  it("rejects absent or structurally invalid reports", () => {
    expect(() => parseProductInvariantReport("not-json")).toThrow(/not valid JSON/);
    expect(() => parseProductInvariantReport("{}")).toThrow(/boolean success/);
    expect(() => parseProductInvariantReport(JSON.stringify({
      success: true,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      numPendingTestSuites: 0,
      testResults: [{ name: "x", status: "passed" }],
    }))).toThrow(/invalid test result/);

    const inconsistent = reportFor([{ id: "PI-001", absolutePath: "/tmp/PI-001.test.ts" }]);
    inconsistent.numPassedTests = 0;
    expect(() => parseProductInvariantReport(JSON.stringify(inconsistent))).toThrow(/counters disagree/);
  });

  it("fails closed when there is no active Product Invariant", () => {
    const root = workspace([]);
    const report = reportFor([]);

    expect(validateProductInvariantInventory([], discoverProductInvariants(root), [])).toContain(
      "no active Product Invariant is registered in test/product-invariants/registry.json",
    );
    expect(validateProductInvariantReport(report, [], root)).toContain(
      "no active Product Invariant is registered in test/product-invariants/registry.json",
    );
  });

  it("cross-checks active machine entries against the human governance registry", () => {
    const root = workspace();
    const file = "test/product-invariants/PI-001-owned-promise.test.ts";
    const registered = registryFor([file], root);
    expect(validateProductInvariantInventory(registered, discoverProductInvariants(root), governanceFor([file]))).toEqual([]);

    const wrongSource = parseProductInvariantGovernanceRegistry([
      "### PI-001 — fixture",
      "",
      "- **Status / owner:** active / fixture maintainers.",
      "- **Source:** `docs/specs/a-different-decision/spec.md`.",
      `- **Executable evidence:** \`${file}\` via the fixture gate.`,
    ].join("\n"));
    expect(validateProductInvariantInventory(registered, discoverProductInvariants(root), wrongSource).join("\n"))
      .toContain("durable source differs between machine and governance registries");

    expect(validateProductInvariantInventory(registered, discoverProductInvariants(root), []).join("\n"))
      .toContain("no active Product Invariant is registered in docs/architecture/product-invariant-testing.md");
  });

  it("requires the exact runtime assertion harness, rejecting commented or conditional lookalikes", () => {
    const root = workspace();
    const setup = path.join(root, "test", "product-invariants", "setup.ts");
    fs.copyFileSync(path.resolve("test/product-invariants/setup.ts"), setup);
    fs.copyFileSync(path.resolve("vitest.product-invariants.config.ts"), path.join(root, "vitest.product-invariants.config.ts"));
    expect(validateProductInvariantHarness(root)).toEqual([]);

    fs.writeFileSync(setup, "// beforeEach(() => expect.hasAssertions());\nif (false) beforeEach(() => expect.hasAssertions());\n", "utf8");
    expect(validateProductInvariantHarness(root)).toContain(
      "test/product-invariants/setup.ts differs from the gate-owned assertion harness",
    );
  });

  it.each(["skipped", "todo", "pending", "disabled"])(
    "rejects the forbidden assertion status %s",
    (status) => {
      const root = workspace();
      const invariants = discoverProductInvariants(root);
      const report = reportFor(invariants);
      report.success = false;
      report.numPassedTests = 0;
      report.testResults[0].status = status;
      report.testResults[0].assertionResults[0].status = status;

      expect(validateProductInvariantReport(report, invariants, root).join("\n")).toContain(
        `has forbidden status ${status}`,
      );
    },
  );

  it("rejects pending and todo counters even when assertion records claim to pass", () => {
    const root = workspace();
    const invariants = discoverProductInvariants(root);
    const report = reportFor(invariants);
    report.numPendingTests = 1;
    report.numTodoTests = 1;
    report.numPendingTestSuites = 1;

    const errors = validateProductInvariantReport(report, invariants, root).join("\n");
    expect(errors).toContain("skipped or pending test(s)");
    expect(errors).toContain("todo test(s)");
    expect(errors).toContain("pending test suite(s)");
  });

  it("rejects a missing expected file and an assertion that does not identify its PI", () => {
    const root = workspace(["PI-001-first.test.ts", "PI-002-second.test.ts"]);
    const invariants = discoverProductInvariants(root);
    const report = reportFor(invariants);
    report.testResults = report.testResults.slice(0, 1);
    report.testResults[0].assertionResults[0].fullName = "PI-999: unrelated promise";
    report.testResults[0].assertionResults[0].ancestorTitles = ["unrelated boundary"];

    const errors = validateProductInvariantReport(report, invariants, root).join("\n");
    expect(errors).toContain("PI-001 was not observed");
    expect(errors).toContain("PI-002 expected file is absent");
  });

  it("rejects duplicate PI IDs and an observed ID without a passing assertion", () => {
    const root = workspace(["PI-001-first.test.ts", "PI-001-second.test.ts"]);
    const invariants = discoverProductInvariants(root);
    const report = reportFor(invariants);
    report.success = false;
    report.numPassedTests = 0;
    for (const result of report.testResults) {
      result.status = "failed";
      result.assertionResults[0].status = "failed";
    }

    const errors = validateProductInvariantReport(report, invariants, root).join("\n");
    expect(errors).toContain("PI-001 is declared by 2 files");
    expect(errors).toContain("PI-001 was observed but did not pass");
  });

  it("keeps the package gate pointed at the validating runner", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["test:invariants"]).toBe("node scripts/run-product-invariants.mjs");
    expect(productInvariantVitestArgs("report.json")).toEqual([
      "run",
      path.join("test", "product-invariants"),
      "--config=vitest.product-invariants.config.ts",
      "--allowOnly=false",
      "--reporter=json",
      "--outputFile=report.json",
    ]);
  });
});
