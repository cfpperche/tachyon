import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nonEmpty, productSourceRoots, workspaceRoot } from "../helpers/repositorySourceScan.js";

const SRC = path.join(__dirname, "../../src");
const ENGINE_SRC = path.join(workspaceRoot("@tachyon/engine"), "src");
const BRIDGE_SRC = path.join(workspaceRoot("@tachyon/bridge"), "src");
const PRODUCT_SOURCE_ROOTS = productSourceRoots();

/**
 * SDD 498 (t-7cb971) — the governed land door is reachable from the INTERFACE and from nowhere else.
 *
 * THIS FILE REPLACES `landCommandNeverExecuted.test.ts`, and it replaces its CLAIM, not just its
 * scope. That guard asserted zero call sites of `merge`/`--ff-only` anywhere in `src/`. The door makes
 * that false by design: the product now performs the fast-forward under a human's click. The
 * adversarial review of SDD 498 (docs/specs/498-governed-land-door/notes.md) had already established
 * why simply narrowing it to "exactly one call site" would be the wrong replacement:
 *
 *   > "Exatamente um call site" não prova a autoridade. … A regra que importa é a ausência de porta
 *   > Agent/Tachyon; a contagem pode ser manutenção, não argumento de segurança.
 *
 * So the two claims below are kept SEPARATE and labelled for what each is worth. The first is the one
 * that matters and it is about reachability. The second is maintenance, and says so.
 */

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) throw new Error(`land-door source root is missing: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every `something([...])` argument list in a source file, as arrays of its string literals. */
function argumentArrays(source: string): string[][] {
  const arrays: string[][] = [];
  const re = /\(\s*\[([^\]]*)\]/g;
  for (const match of source.matchAll(re)) {
    const literals = [...match[1].matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
    if (literals.length > 0) arrays.push(literals);
  }
  return arrays;
}

/**
 * The surfaces an AGENT can reach: the Bridge's tools, the host-action broker and its capability
 * registry, and the agent-side adapter that drives it. `run_host_action` looks like the natural home
 * for "the product does something on the host", which is exactly why it is named here — the broker
 * refuses any caller whose kind is not `"agent"` (`packages/engine/src/host-action/policy.ts`), so a land door
 * registered there would be reachable ONLY by agents and by no human at all.
 */
const AGENT_REACHABLE = ["bridge", "host-action", "agent-vscode"];
const agentReachableRoot = (dir: string): string => dir === "bridge" ? BRIDGE_SRC : path.join(ENGINE_SRC, dir);

const LAND_ACTION = "worktree.land";

describe("the land door has no agent-facing door", () => {
  it("no agent-reachable surface names the land operation", () => {
    const offenders: string[] = [];
    for (const dir of AGENT_REACHABLE) {
      for (const file of nonEmpty(sourceFiles(agentReachableRoot(dir)), `land-door ${dir} source scan`)) {
        if (fs.readFileSync(file, "utf8").includes(LAND_ACTION)) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The structural half, and the reason this survives actions that do not exist yet: extension
   * operations are dispatched by the Interface through the engine, and the Bridge does not hold the
   * registry at all. A future tool that wanted to proxy one would have to import this module first.
   */
  it("no Bridge tool can dispatch extension operations at all", () => {
    const offenders = nonEmpty(sourceFiles(BRIDGE_SRC), "land-door bridge source scan")
      .filter((file) => /runtime-api\/extensionOperations/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  /**
   * MAINTENANCE, NOT A SECURITY ARGUMENT — stated so no later reader mistakes it for one.
   *
   * It records that the mutating verb still lives at one address, which keeps the file a reviewer has
   * to read small. It cannot see an argument list built from a variable, a shell, or another wrapper,
   * so it proves nothing about who can reach the effect; the two tests above are what do that.
   *
   * It scans ARGUMENT ARRAYS rather than lines for the reason the guard it replaces did: a `grep` for
   * `merge` matches `merge-base`, which both land modules legitimately call, and a line-level guard
   * that has to excuse its honest callers is the shape that already failed here on 2026-08-03.
   */
  it("only landAct.ts passes the mutating verb to git", () => {
    const mutating = new Set(["merge", "--ff-only"]);
    const offenders: string[] = [];
    for (const file of nonEmpty(PRODUCT_SOURCE_ROOTS.flatMap(sourceFiles), "land-door repository source scan")) {
      const relative = path.relative(SRC, file);
      if (relative === path.join("worktree", "landAct.ts")) continue;
      for (const args of argumentArrays(fs.readFileSync(file, "utf8"))) {
        const hit = args.find((arg) => mutating.has(arg));
        if (hit) offenders.push(`${relative}: [${args.join(", ")}] contains '${hit}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads merge-base as a different word than merge, so the honest caller is not excused", () => {
    const mutating = new Set(["merge", "--ff-only"]);
    expect(argumentArrays(`await git(["merge-base", "--is-ancestor", a, b], cwd)`)).toEqual([["merge-base", "--is-ancestor"]]);
    expect(argumentArrays(`await git(["merge-base", "--is-ancestor", a, b], cwd)`).some(
      (list) => list.some((arg) => mutating.has(arg)),
    )).toBe(false);
    expect(argumentArrays(`await git(["merge", "--ff-only", head], cwd)`).some(
      (list) => list.some((arg) => mutating.has(arg)),
    )).toBe(true);
  });
});
