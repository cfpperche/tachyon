import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEBVIEW_APPS, WEBVIEW_APP_REACHABLE_BUDGET_BYTES } from "../../apps/vscode-extension/src/webview/webviewApps.js";
import { WEBVIEW_SURFACES } from "../../apps/vscode-extension/src/webview/surfaces.js";
import { workspaceRoot } from "../helpers/repositorySourceScan.js";

/**
 * SDD 485 C3 — successor to `cockpitBundleBudget.test.ts`, which measured ONE hardcoded filename
 * (`dist/webview/cockpit.js`, 350 KB). That shape cannot survive the app count going back up: it would keep
 * passing while eleven other apps grew without limit, and it would keep passing if somebody replaced the one
 * splitting invocation with twelve independent builds — the change `spec.md` rejected precisely because it
 * would copy Preact and the kit into every app and reopen 410's budget hole for real.
 *
 * So this is driven from the app manifest and measures three things instead of one:
 *   1. each app's EAGER entry — the bytes a webview must fetch and run before it can paint;
 *   2. each app's REACHABLE total — entry plus every chunk reachable from it, which is what code-splitting
 *      makes it trivial to hide bytes behind;
 *   3. that the apps actually SHARE chunks. Without this the first two numbers stay green under the exact
 *      regression they exist to catch: twelve small entries, each with its own private copy of the kit.
 *
 * `dist/` may be absent on a typecheck-only local run; `verify:full` builds before it runs the suite, so the
 * measurements below are real in every gate that matters.
 */

const WEBVIEW_DIR = join(workspaceRoot("tachyon"), "dist", "webview");
/**
 * t-a12966 — this probe was `existsSync("dist/webview/cockpit.js")`, the exact hardcoded filename
 * the header above mocks its predecessor for. `t-5a0c1c` retired the cockpit bundle, so the probe
 * answered "not built" on a fully built tree and all three measurements below had been skipping in
 * every gate since — silently, because a `runIf` reports a pending test and no reason. Derived from
 * the manifest instead: it cannot go stale without the manifest itself being wrong, which the two
 * unconditional tests above already catch.
 */
const built = WEBVIEW_APPS.every((app) => existsSync(join(WEBVIEW_DIR, `${app.view}.js`)));

let reachableWebviewChunkBasenames: (dir: string, entries?: string[]) => Set<string>;

beforeAll(async () => {
  ({ reachableWebviewChunkBasenames } = await import("../../scripts/webview-chunk-hygiene.mjs"));
});

const entryFile = (view: string): string => join(WEBVIEW_DIR, `${view}.js`);
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

function reachable(view: string): { chunks: string[]; total: number } {
  const chunks = [...reachableWebviewChunkBasenames(WEBVIEW_DIR, [`${view}.js`])].sort();
  const total = statSync(entryFile(view)).size
    + chunks.reduce((sum, c) => sum + statSync(join(WEBVIEW_DIR, "chunks", c)).size, 0);
  return { chunks, total };
}

describe("standalone webview app budgets (SDD 485 C3)", () => {
  it("the build's entry list and the app manifest agree, in BOTH directions", () => {
    // esbuild.mjs cannot import a TS module, so it carries its own array. This is what stops the two from
    // drifting: an app added to one and not the other fails here by name, not by a mystery at package time.
    const esbuild = readFileSync("esbuild.mjs", "utf8");
    const declared = /const WEBVIEW_APP_VIEWS = \[([\s\S]*?)\];/.exec(esbuild)?.[1];
    expect(declared, "WEBVIEW_APP_VIEWS not found in esbuild.mjs — did the multi-entry invocation move?").toBeTruthy();
    const built = [...declared!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]).sort();
    expect(built).toEqual(WEBVIEW_APPS.map((a) => a.view).sort());
    expect(esbuild).toContain("splitting: true");
    expect(esbuild).toContain('chunkNames: "chunks/app-[name]-[hash]"');
  });

  it("every app is a real surface with a posture — an app is never outside the Phase A contract", () => {
    const surfaces = new Map(WEBVIEW_SURFACES.map((s) => [s.viewId, s]));
    for (const app of WEBVIEW_APPS) {
      const surface = surfaces.get(app.viewId);
      expect(surface, `app '${app.view}' declares viewId '${app.viewId}' with no WEBVIEW_SURFACES row`).toBeTruthy();
      expect(surface!.view, `app '${app.view}' and surface '${app.viewId}' disagree about the bundle name`).toBe(app.view);
    }
  });

  it.runIf(built)("keeps every app's EAGER entry inside its budget", () => {
    const report: string[] = [];
    const over: string[] = [];
    for (const app of WEBVIEW_APPS) {
      expect(existsSync(entryFile(app.view)), `app '${app.view}' has no built entry at ${entryFile(app.view)}`).toBe(true);
      const size = statSync(entryFile(app.view)).size;
      report.push(`${app.view}: ${kb(size)} of ${kb(app.eagerBudgetBytes)}`);
      if (size > app.eagerBudgetBytes) over.push(`${app.view} eager entry is ${kb(size)} (budget ${kb(app.eagerBudgetBytes)})`);
    }
    expect(over, `${over.join("; ")}\nmeasured: ${report.join(" · ")}`).toEqual([]);
  });

  it.runIf(built)("keeps every app's REACHABLE graph inside the budget (splitting must not hide the cost)", () => {
    const over: string[] = [];
    const report: string[] = [];
    for (const app of WEBVIEW_APPS) {
      const { chunks, total } = reachable(app.view);
      report.push(`${app.view}: ${kb(total)} across ${chunks.length} chunk(s)`);
      if (total > WEBVIEW_APP_REACHABLE_BUDGET_BYTES) {
        over.push(`${app.view} reaches ${kb(total)} (budget ${kb(WEBVIEW_APP_REACHABLE_BUDGET_BYTES)})`);
      }
    }
    expect(over, `${over.join("; ")}\nmeasured: ${report.join(" · ")}`).toEqual([]);
  });

  it.runIf(built && WEBVIEW_APPS.length > 1)("proves the apps SHARE chunks — one invocation, not N independent builds", () => {
    // The regression this catches is invisible to a size budget: twelve entries, each small, each carrying
    // its own private Preact + kit. `spec.md` rejected that build shape by name; this is what notices if it
    // comes back.
    const owners = new Map<string, string[]>();
    for (const app of WEBVIEW_APPS) {
      for (const chunk of reachable(app.view).chunks) {
        owners.set(chunk, [...(owners.get(chunk) ?? []), app.view]);
      }
    }
    const shared = [...owners.entries()].filter(([, apps]) => apps.length > 1);
    expect(
      shared.length,
      `no chunk is reachable from more than one app — Preact and the kit are being copied per app, not extracted (${owners.size} chunk(s) seen)`,
    ).toBeGreaterThan(0);
  });
});
