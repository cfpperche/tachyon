import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * t-70fda0 / t-eccb00 — optional runtime credentials skip in the TEST, not in the report.
 *
 * t-eccb00 classified claude/opencode. t-70fda0 found the same disease still open for codex:
 * host auth was usually present on the primary machine, so the gate stayed green there and red
 * only when HOME was redirected (agent private home, empty fixture home). A note in a journal is
 * not a guard — this file fails when classification goes missing or becomes vacuous.
 *
 * What it measures (source shape, not runtime):
 * 1. Every `skipTestsWithoutOptionalRuntimeAuth({…})` title exists as `it("…")` in that file.
 *    A rename that leaves a stale title silently stops skipping (coverage vanishes).
 * 2. Known real-harness codex call sites from the t-70fda0 scan declare a `codex:` list.
 * 3. A synthetic source without classification fails the same checks — the guard is not vacuous.
 */

const ROOT = path.resolve(__dirname, "../..");
const UNIT = path.join(ROOT, "test/unit");

/** Files measured under empty HOME as real-harness codex materializers (t-70fda0 scan). */
const REAL_HARNESS_CODEX_FILES = [
  "engineService.test.ts",
  "workspaceHeadless.test.ts",
  "continuityWiring.test.ts",
] as const;

function unitTestFiles(): Array<{ file: string; source: string }> {
  return fs
    .readdirSync(UNIT)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => ({
      file: path.join("test/unit", name),
      source: fs.readFileSync(path.join(UNIT, name), "utf8"),
    }));
}

/** Double-quoted string literals only — titles use `"` and often contain apostrophes (`child's`). */
function doubleQuotedStrings(chunk: string): string[] {
  return [...chunk.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) => m[1]!.replace(/\\"/g, '"'));
}

function itTitles(source: string): Set<string> {
  const titles = new Set<string>();
  for (const match of source.matchAll(/\bit\(\s*"((?:\\.|[^"\\])*)"/g)) {
    titles.add(match[1]!.replace(/\\"/g, '"'));
  }
  return titles;
}

/**
 * Extract `skipTestsWithoutOptionalRuntimeAuth({ … })` maps. Balanced-brace scan — enough for the
 * call shape this helper always uses (one object literal at module scope).
 */
function skipMaps(source: string): Array<{ runtime: string; titles: string[] }> {
  const marker = "skipTestsWithoutOptionalRuntimeAuth(";
  const start = source.indexOf(marker);
  if (start < 0) return [];
  const brace = source.indexOf("{", start);
  if (brace < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const body = source.slice(brace + 1, end);
  const out: Array<{ runtime: string; titles: string[] }> = [];
  for (const runtime of ["claude", "codex", "opencode"] as const) {
    // Array body: scan for the key, then take the balanced `[…]` that follows (titles may contain `]`).
    const key = body.indexOf(`${runtime}:`);
    if (key < 0) continue;
    const open = body.indexOf("[", key);
    if (open < 0 || open > key + runtime.length + 8) continue;
    let d = 0;
    let close = -1;
    for (let i = open; i < body.length; i++) {
      if (body[i] === "[") d++;
      else if (body[i] === "]") {
        d--;
        if (d === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    out.push({ runtime, titles: doubleQuotedStrings(body.slice(open + 1, close)) });
  }
  return out;
}

/**
 * t-a12966 — a file answers for a runtime in one of TWO ways, and the guard accepts either.
 *
 * t-70fda0 wrote this check when "declare and skip" was the only answer available, so it demanded a
 * `codex:` list by name. Injecting a disposable credential home is the BETTER answer wherever the
 * credential is only substrate — it makes the test run everywhere instead of running only where the
 * host is logged in — and a guard that rejected it would push the classification back to the worse
 * option. What must never happen is neither, which is the hole this still catches.
 */
function classifiedFor(source: string, runtime: string): boolean {
  if (new RegExp(`useDisposableRuntimeAuth\\(\\[[^\\]]*"${runtime}"`).test(source)) return true;
  const map = skipMaps(source).find((entry) => entry.runtime === runtime);
  return Boolean(map && map.titles.length > 0);
}

describe("optional runtime auth classification (t-70fda0)", () => {
  it("every listed skip title exists as it(\"…\") in the same file — renames cannot leave a silent hole", () => {
    // Only call sites: a mention inside this guard's own source is not a classification map.
    const files = unitTestFiles().filter((row) => skipMaps(row.source).length > 0);
    // t-ed0f43 — this used to assert `files.length > 0`, because when the check was written every
    // classified file declared a skip list and a `skipMaps()` that silently stopped parsing would
    // have emptied this loop and passed. That anchor died of its own success: injection replaced the
    // last declare-and-skip call site in the repo, so demanding one would force a file back to the
    // worse classification just to keep this green. What replaces it is not nothing — the synthetic
    // case at the bottom of this describe runs `skipMaps()` over a source that DOES declare one and
    // asserts the rename is caught, so a broken scanner is still red without depending on any real
    // file. The loop below stays: it covers the next call site the moment one appears.
    for (const row of files) {
      const titles = itTitles(row.source);
      const maps = skipMaps(row.source);
      for (const map of maps) {
        expect(map.titles.length, `${row.file}: ${map.runtime} skip list is empty`).toBeGreaterThan(0);
        for (const title of map.titles) {
          expect(
            titles.has(title),
            `${row.file}: skip list for ${map.runtime} names "${title}" but no it() carries that title`,
          ).toBe(true);
        }
      }
    }
  });

  it("measured real-harness codex call sites are CLASSIFIED — injected or declared (t-70fda0, t-a12966)", () => {
    for (const name of REAL_HARNESS_CODEX_FILES) {
      const source = fs.readFileSync(path.join(UNIT, name), "utf8");
      expect(
        classifiedFor(source, "codex"),
        `test/unit/${name} materializes real codex harness with no classification — inject it with `
          + "useDisposableRuntimeAuth([\"codex\"]) or declare it with skipTestsWithoutOptionalRuntimeAuth({ codex: […] })",
      ).toBe(true);
    }
  });

  it("REAL_HARNESS_CODEX_FILES is not vacuous — each named file exists", () => {
    for (const name of REAL_HARNESS_CODEX_FILES) {
      expect(fs.existsSync(path.join(UNIT, name)), `missing ${name}`).toBe(true);
    }
  });

  it("detects a renamed skip title and a file that forgot codex classification — the guard is not vacuous", () => {
    // Synthetic sources shaped like the pre-fix holes. A scanner that always returns green is worthless.
    const renamed = `
      import { skipTestsWithoutOptionalRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
      skipTestsWithoutOptionalRuntimeAuth({ codex: ["old title that was renamed"] });
      it("new title after rename", async () => {});
    `;
    const titles = itTitles(renamed);
    const maps = skipMaps(renamed);
    expect(maps[0]!.titles.every((t) => titles.has(t))).toBe(false);

    // Shape of a real-harness codex assertion without classification — do NOT name a fixture
    // *Worker.ts path here: daemonFixtureEnvIsolation (t-93ec7f) treats any file that mentions those
    // filenames as a spawn site and would require isolatedDaemonChildEnv on this guard itself.
    const forgotCodex = `
      it("owns a real Workspace and direct Bridge across shell replacement and no-shell time", async () => {
        expect(started).toEqual({ method: "agent.start", status: "ok" });
      });
    `;
    expect(forgotCodex.includes("skipTestsWithoutOptionalRuntimeAuth")).toBe(false);
    expect(skipMaps(forgotCodex).some((m) => m.runtime === "codex")).toBe(false);
    expect(classifiedFor(forgotCodex, "codex")).toBe(false);

    // …and the two shapes that DO answer are both accepted, so the guard cannot quietly forbid one.
    expect(classifiedFor('useDisposableRuntimeAuth(["claude", "codex"]);', "codex")).toBe(true);
    expect(classifiedFor('useDisposableRuntimeAuth(["claude"]);', "codex")).toBe(false);
    expect(classifiedFor(renamed, "codex")).toBe(true);
  });
});
