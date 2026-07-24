import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCockpitModel, type CockpitWorkspaceBundle } from "../../src/cockpit/model.js";
import { EXTENSION_QUERY_ACTIONS, extensionQuerySchema } from "../../src/runtime-api/extensionOperations.js";

/**
 * t-43c6fa — Control's Deliveries tab reads the engine's classified GitDelivery RPC, mirroring what
 * spec 444 did for Worktrees.
 *
 * The bug this closes was not merely "raw disk instead of validated store": `readGitDeliveriesFromDisk`
 * read `.tachyon/git-deliveries/*.json`, a LEGACY mirror directory that no longer exists and that
 * nothing writes (the canonical store is `.tachyon/git-deliveries-v2.sqlite3`). With `catch {} → []`,
 * "directory absent" was indistinguishable from "no deliveries", so the tab rendered permanently empty
 * while the real store held records — a silent total outage, not a degraded read.
 */

// process.cwd() is the repo root under vitest — the idiom the sibling structural tests use
// (activityLayout.test.ts). `import.meta` is not available: test/ also builds under the CommonJS
// tsconfigs that `npm run typecheck` runs.
const repoRoot = process.cwd();

function bundle(over: Partial<CockpitWorkspaceBundle> = {}): CockpitWorkspaceBundle {
  return {
    control: {
      folderName: "tachyon",
      workspaceRoot: "/w",
      wsHash: "abc",
      bridgeUrl: "http://127.0.0.1:7421/mcp",
      agents: { total: 0, running: 0 },
    } as CockpitWorkspaceBundle["control"],
    agents: [],
    worktrees: [],
    deliveries: [],
    approvals: [],
    tmux: { state: "healthy" },
    ...over,
  } as CockpitWorkspaceBundle;
}

describe("Deliveries classified read (t-43c6fa)", () => {
  it("exposes deliveries.classified as a strict, argument-free extension query", () => {
    expect(EXTENSION_QUERY_ACTIONS).toContain("deliveries.classified");
    expect(extensionQuerySchema.safeParse({ action: "deliveries.classified" }).success).toBe(true);
    // Strict: no unexpected arguments may ride along on a read the engine serves unconditionally.
    expect(extensionQuerySchema.safeParse({ action: "deliveries.classified", agent: "x" }).success).toBe(false);
  });

  it("carries the spec 365 classification through to the model instead of dropping it", () => {
    const m = buildCockpitModel(
      [
        bundle({
          deliveries: [
            {
              id: "gd-1",
              phase: "open",
              branchRef: "tachyon/x",
              liveState: "live",
              containedInBase: false,
              missingRef: true,
              clean: false,
              safetyClass: "terminal",
              reasons: ["branch missing"],
            },
          ],
        }),
      ],
      { section: "deliveries", nowIso: "now" },
    );
    expect(m.deliveries).toHaveLength(1);
    expect(m.deliveries[0]).toMatchObject({
      liveState: "live",
      containedInBase: false,
      missingRef: true,
      clean: false,
      safetyClass: "terminal",
      reasons: ["branch missing"],
    });
  });

  it("surfaces an unavailable engine as its own per-folder state, never as an empty list", () => {
    const m = buildCockpitModel(
      [
        bundle({ deliveries: [], deliveriesUnavailable: "engine returned no deliveries payload" }),
        bundle({ control: { ...bundle().control, folderName: "other" }, deliveries: [{ id: "gd-2", phase: "open", branchRef: "b" }] }),
      ],
      { section: "deliveries", nowIso: "now" },
    );
    expect(m.deliveriesUnavailable).toEqual([
      { folder: "tachyon", reason: "engine returned no deliveries payload" },
    ]);
    // The healthy folder still contributes its rows — one bad engine does not blank the whole tab.
    expect(m.deliveries.map((d) => d.id)).toEqual(["gd-2"]);
  });

  it("omits deliveriesUnavailable entirely when every folder answered", () => {
    const m = buildCockpitModel([bundle({ deliveries: [{ id: "gd-3", phase: "open", branchRef: "b" }] })], {
      section: "deliveries",
      nowIso: "now",
    });
    expect(m.deliveriesUnavailable).toBeUndefined();
  });

  /**
   * The class-level guard, not the instance. Both raw readers are gone (spec 444 took the worktree
   * one, this task the delivery one) and `src/cockpit/disk.ts` with them. These registries are
   * engine-owned and reachable only over RPC; a new Cockpit-side reader would silently reintroduce
   * exactly the outage above, so it fails here instead.
   */
  it("keeps canonical registries out of the Cockpit host path (no raw reader may come back)", () => {
    expect(fs.existsSync(path.join(repoRoot, "src", "cockpit", "disk.ts"))).toBe(false);

    const OWNED_BY_ENGINE = [".tachyon/git-deliveries", "git-deliveries-v2.sqlite3", "managed-worktrees.json"];
    const cockpitDir = path.join(repoRoot, "src", "cockpit");
    const files = fs
      .readdirSync(cockpitDir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .map((f) => path.join(cockpitDir, f));
    files.push(path.join(repoRoot, "src", "extension.ts"));

    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // Comments explaining the deleted readers are the point of this guard, not a violation.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        for (const marker of OWNED_BY_ENGINE) {
          if (code.includes(marker)) offenders.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
