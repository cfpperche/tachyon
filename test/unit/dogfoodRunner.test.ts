import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("dogfood command surface", () => {
  it("keeps the development harness out of the npm script surface", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const developmentAliases = ["dogfood", "preview:webview", "preview:webview:catalog", "activity:preview"];
    expect(Object.keys(pkg.scripts).filter((name) => developmentAliases.includes(name) || name.startsWith("dogfood:"))).toEqual([]);
  });

  it("lists the migrated scenarios through the runner", () => {
    const scenarios = execFileSync(process.execPath, ["scripts/dogfood/run.mjs", "--list"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim().split("\n");
    expect(scenarios).toContain("dev-host");
    expect(scenarios).toContain("runtime-launch-preflight");
    expect(scenarios).toContain("claude-canonical-create");
    expect(scenarios).toContain("persistent-engine");

    // `--list` is the discovery surface, so a name printed twice is a listing defect on its own.
    expect(scenarios).toEqual([...new Set(scenarios)]);

    // This line used to read `expect(new Set(scenarios).size).toBe(22)`. A COUNT is the wrong
    // assertion for this door: it goes red on every legitimately added scenario — t-0ac2e9 adding
    // "runtime-remeasure" is what reddened main — and when it does, it reports "23 !== 22" without
    // naming which scenario moved. The invariant a count was standing in for is that everything the
    // runner ADVERTISES it can run, it can actually run: each listed name resolves to one of the
    // runner's special-cased commands or to scripts/dogfood/<name>.{ts,mts,mjs}. That stays silent
    // when a scenario is added correctly and names the offender when one is added wrong.
    const source = fs.readFileSync(path.join(repoRoot, "scripts", "dogfood", "run.mjs"), "utf8");
    const exceptions = source.slice(source.indexOf("const exceptions = {"), source.indexOf("const scenarios = ["));
    expect(exceptions).toContain("dev-host"); // the slice above must not silently come back empty
    const unrunnable = scenarios.filter(
      (name) =>
        !exceptions.includes(`"${name}":`) &&
        ![".ts", ".mts", ".mjs"].some((ext) => fs.existsSync(path.join(repoRoot, "scripts", "dogfood", `${name}${ext}`))),
    );
    expect(unrunnable).toEqual([]);
  });

  it("resolves dev-host commands with or without npm's extra separator", () => {
    const run = (args: string[]) =>
      execFileSync(process.execPath, ["scripts/dogfood/run.mjs", "dev-host", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
      });

    expect(run(["--", "help"])).toBe(run(["help"]));
  });
});
