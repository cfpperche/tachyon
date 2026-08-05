import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { HANG_TIMEOUT_MS } from "./support/hangTimeout";
import { openPreview } from "./support/preview";

// t-2a49b2 — layout-first rewrite of the Runtime Ops browser suite.
//
// History (kept short; the journal owns the rest):
//   - t-ed3067 retired `?view=runtime-ops`; four tests went red and stayed red on purpose.
//   - SDD 485 D3 restored the standalone route; t-6e929b put the suite on the conditional gate.
//   - t-b8e416 measured this file at 40.00s inside the concurrent gate and asked for an aggressive
//     rewrite: keep two widths + overflow/breakpoint/focus; drop the textual matrix already covered
//     by named unit files. The session-inspection panel from t-283149 was never on that list.
//
// What this file proves NOW (browser-only):
//   - table grid → flex at the narrow breakpoint, header hidden, page/cell overflow free
//   - provider capacity row grid → flex + visible focus outline
//   - session inspection panel (launch <pre> + settings/env grids) contained at 340px
//
// What was removed, and the unit that owns each claim (do not re-add without dropping the pair):
//   - loading/error/empty/mixed/throttled/stale/duplicate fixture text and agent-count smoke
//       → `runtimeOpsModel.test.ts` (summary counts, throttle/bridge projection, workspace labels)
//       → `runtimeOpsApp.test.ts` ("snapshot that cannot be built posts the UNAVAILABLE inventory")
//       → `runtimeOpsSnapshotService.test.ts` (lifecycle/throttle projection without matchedLine)
//   - RAW_* marker DOM scans on throttled + provider-invalid
//       → `runtimeOpsModel.test.ts` "drops hostile raw host values before they become snapshot protocol data"
//       → `runtimeOpsProviderProjection.test.ts` "re-allows only quota/source/confidence… and strips … raw"
//       → `runtimeOpsSnapshotService.test.ts` "projects … without serializing matchedLine"
//   - 8-state × 2-width provider capacity TEXT matrix (Exact confidence / 100% used / …)
//       → `runtimeOpsProviderProjection.test.ts` (confidence, unavailable reasons, disabled, stale, strip)
//   - "Native usage" / "Summed activity deltas" / "managed agent" copy checks
//       → usage semantics: `runtimeOpsModel.test.ts` + `runtimeOpsSnapshotService.test.ts`
//       → account-wide non-attribution: `runtimeOpsProviderProjection.test.ts`
//         "publishes schema V2 with account capacity separate from native runtime and agent attribution"
//   - session inspection CONTENT (hooks/settings/MCP/env/redaction/live-vs-file)
//       → `runtimeOpsSessionInspectionView.test.ts` (static Preact render of the real App)
//
// Content of the inspection panel stays in units. This file owns geometry of the panel that units cannot
// measure: the launch <pre> and the two grids (settings, env) at 340px — the width the brief named.
//
// `test:browser` still needs system Chrome; it is on the conditional verify gate (t-6e929b), not the
// unconditional full path. That is deliberate.

/** mixed fixture agent key — `workspaceKey:agentName` from `buildRuntimeOpsSnapshot`. */
const MIXED_CLAUDE_KEY = "a1b2c3:claude";

interface Viewport {
  width: number;
  height: number;
}

/**
 * Payload deliberately long: a multi-arg launch line plus multi-column settings/env so a 340px box
 * has something real to clip if wrapping/grid collapse fail. Content assertions live in
 * `runtimeOpsSessionInspectionView.test.ts`; this object only exists to stress layout.
 */
const RICH_INSPECTION = {
  agent: "claude",
  runtime: "claude",
  state: "live" as const,
  command: [
    "claude",
    "--resume",
    "sess_abc123xyz_deliberately_long_session_id_for_wrap",
    "--settings",
    "/home/goat/.cache/tachyon/worktrees/example/project/.tachyon/harness/claude/settings/projected-settings.json",
    "--mcp-config",
    "/home/goat/.cache/tachyon/worktrees/example/project/.tachyon/harness/claude/mcp/servers.json",
    "--bridge-token",
    "•••",
  ],
  hooks: [
    {
      event: "SessionStart",
      command: "node session-owner-record.cjs",
      purpose: "records which agent owns this session",
      writes: ".tachyon/activity/session-owners.jsonl",
    },
    {
      event: "PreToolUse",
      command: "bash /home/goat/my-own-hook-with-a-very-long-path/tools/guard.sh --strict",
    },
  ],
  settings: [
    { key: "permissions", value: "bypassPermissions", origin: "projected" as const },
    { key: "skipDangerousModePermissionPrompt", value: "true", origin: "host" as const },
    {
      key: "statusLine",
      value: "node wrapper.cjs",
      origin: "host" as const,
      wraps: "bash ~/.claude/statusline-command.sh",
    },
    {
      key: "switchModelsOnFlag",
      value: "true",
      origin: "not-projected" as const,
    },
  ],
  mcpServers: ["tachyon_bridge", "some_other_server_with_a_long_identifier"],
  strictMcp: true,
  env: [
    { key: "TACHYON_AGENT_NAME", value: "claude" },
    { key: "TACHYON_BRIDGE_TOKEN", value: "•••" },
    {
      key: "TACHYON_WORKSPACE_ROOT",
      value: "/home/goat/.cache/tachyon/worktrees/example/project-with-a-deliberately-long-path-segment",
    },
  ],
  notExposed: [] as string[],
};

/**
 * t-b24282 — ONE size, passed to the harness. The frame is an iframe whose content box is the surface's
 * viewport, so the `@media (max-width: 760px)` this file is about evaluates at the requested width; the
 * browser viewport is set alongside only so an element screenshot would not be cropped. The hand-resize
 * of `#frame` this helper used to do afterwards is gone with the div it patched around.
 */
async function openRuntimeOpsFixture(page: Page, origin: string, fixture: string, viewport: Viewport): Promise<Frame> {
  await page.setViewport(viewport);
  const surface = await openPreview(page, origin, {
    query: { view: "runtime-ops", fixture },
    width: viewport.width,
    height: viewport.height,
    waitFor: ".runtime-ops",
    timeout: 5000,
  });
  await surface.waitForFunction((name: string) => document.body.dataset.previewFixture === name, { timeout: 5000 }, fixture);
  return surface;
}

async function hasNoHorizontalOverflow(surface: Frame): Promise<boolean> {
  return surface.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
}

async function hasNoCellOverflow(surface: Frame): Promise<boolean> {
  return surface.evaluate(() => [...document.querySelectorAll<HTMLElement>(".runtime-ops-cell")]
    .every((cell) => cell.scrollWidth <= cell.clientWidth + 1));
}

/** Session panel geometry: neither the panel nor its pre/grids may scroll sideways inside the frame —
 *  which IS this document's viewport now, so the frame's right edge is `window.innerWidth`. */
async function sessionPanelContainedInFrame(surface: Frame): Promise<boolean> {
  return surface.evaluate(() => {
    const panel = document.querySelector<HTMLElement>(".runtime-ops-session");
    if (!panel) return false;
    const pr = panel.getBoundingClientRect();
    if (pr.right > window.innerWidth + 1) return false;
    const nodes = [
      panel,
      ...panel.querySelectorAll<HTMLElement>(
        ".runtime-ops-session-command, .runtime-ops-session-setting, .runtime-ops-session-kv, .runtime-ops-session-hook, .runtime-ops-session-kv > div",
      ),
    ];
    return nodes.every((el) => el.scrollWidth <= el.clientWidth + 1);
  });
}

/**
 * Expand the mixed-fixture claude row and inject a host inspection reply.
 * The preview stub's `acquireVsCodeApi` swallows the inspect request (only re-posts READY), so the
 * test is the host: post `runtimeOpsSessionInspection` once the client has the row in loading state.
 */
async function openSessionInspection(surface: Frame, inspection: typeof RICH_INSPECTION): Promise<void> {
  await surface.click(".runtime-ops-agents summary");
  await surface.waitForSelector(`[data-agent-key="${MIXED_CLAUDE_KEY}"] .runtime-ops-inspect-toggle`, {
    visible: true,
    timeout: 3000,
  });
  await surface.click(`[data-agent-key="${MIXED_CLAUDE_KEY}"] .runtime-ops-inspect-toggle`);
  await surface.waitForSelector(".runtime-ops-session[aria-busy='true']", { visible: true, timeout: 3000 });

  await surface.evaluate(
    (agentKey, payload) => {
      window.postMessage({ type: "runtimeOpsSessionInspection", agentKey, inspection: payload }, "*");
    },
    MIXED_CLAUDE_KEY,
    inspection,
  );
  await surface.waitForSelector(".runtime-ops-session-command", { visible: true, timeout: 3000 });
}

describe("Runtime Ops view (layout + session inspection — t-2a49b2)", () => {
  let server: GateServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it("uses the wide table at 1100x360 with keyboard-operable agent details and visible focus", async () => {
    const page = await browser.newPage();
    const surface = await openRuntimeOpsFixture(page, server.origin, "mixed", { width: 1100, height: 360 });

    expect(await surface.$eval(".runtime-ops-row", (el) => getComputedStyle(el).display)).toBe("grid");
    expect(await hasNoHorizontalOverflow(surface)).toBe(true);
    expect(await hasNoCellOverflow(surface)).toBe(true);

    await surface.focus(".runtime-ops-agents summary");
    const focus = await surface.$eval(".runtime-ops-agents summary", (el) => ({
      active: document.activeElement === el,
      outlineWidth: getComputedStyle(el).outlineWidth,
      outlineStyle: getComputedStyle(el).outlineStyle,
    }));
    expect(focus.active).toBe(true);
    expect(focus.outlineWidth).toBe("2px");
    expect(focus.outlineStyle).toBe("solid");

    await page.keyboard.press("Space");
    await surface.waitForFunction(() => document.querySelector(".runtime-ops-agents")?.hasAttribute("open"), { timeout: HANG_TIMEOUT_MS });
    expect(await surface.$eval(".runtime-ops-agents", (el) => el.hasAttribute("open"))).toBe(true);
    expect(await surface.$eval(".runtime-ops-agents summary", (el) => document.activeElement === el)).toBe(true);
    await page.close();
  });

  it("uses labeled rows at 340x760 without page or cell overflow, including long labels", async () => {
    const page = await browser.newPage();
    const surface = await openRuntimeOpsFixture(page, server.origin, "long-label", { width: 340, height: 760 });

    expect(await surface.$eval(".runtime-ops-row", (el) => getComputedStyle(el).display)).toBe("flex");
    expect(await surface.$eval(".runtime-ops-header", (el) => getComputedStyle(el).display)).toBe("none");
    // Precondition that the long-label fixture landed (not a content matrix). Layout is the claim.
    await surface.click(".runtime-ops-agents summary");
    expect(await surface.$eval(".runtime-ops", (el) => el.textContent))
      .toContain("migration-coordinator-with-a-deliberately-long-operational-label");
    expect(await hasNoHorizontalOverflow(surface)).toBe(true);
    expect(await hasNoCellOverflow(surface)).toBe(true);
    await page.close();
  });

  it("provider capacity: grid at 1100, flex at 340, no overflow, visible control focus", async () => {
    // One fixture × two widths. Capacity STATE text (Exact confidence, 100% used, …) lives in
    // `runtimeOpsProviderProjection.test.ts` — not re-asserted here across eight fixtures.
    const page = await browser.newPage();

    let surface = await openRuntimeOpsFixture(page, server.origin, "provider-healthy", { width: 1100, height: 760 });
    expect(await surface.$(".runtime-ops-provider-row")).not.toBeNull();
    expect(await surface.$eval(".runtime-ops-provider-row", (el) => getComputedStyle(el).display)).toBe("grid");
    expect(await hasNoHorizontalOverflow(surface)).toBe(true);

    await surface.focus(".runtime-ops-provider-control button");
    const controlFocus = await surface.$eval(".runtime-ops-provider-control button", (element) => ({
      active: document.activeElement === element,
      outlineWidth: getComputedStyle(element).outlineWidth,
      outlineStyle: getComputedStyle(element).outlineStyle,
    }));
    expect(controlFocus).toEqual({ active: true, outlineWidth: "2px", outlineStyle: "solid" });

    surface = await openRuntimeOpsFixture(page, server.origin, "provider-healthy", { width: 340, height: 900 });
    expect(await surface.$eval(".runtime-ops-provider-row", (el) => getComputedStyle(el).display)).toBe("flex");
    expect(await hasNoHorizontalOverflow(surface)).toBe(true);
    await page.close();
  });

  it("session inspection panel stays inside the frame at 340px (launch pre + settings/env grids)", async () => {
    // t-283149 landed without visual evidence. This is that evidence: the panel's <pre> launch
    // command and two grids (settings, env) at the width the brief named (340), not only 880/360.
    // Content of the panel: `runtimeOpsSessionInspectionView.test.ts`. Geometry only, here.
    //
    // RED-BEFORE-GREEN: first run inverted the containment assertion (expected false) and watched
    // it fail while the panel rendered correctly — harness sees overflow, not a free pass. Then
    // restored the real claim (contained === true). Evidence: journal of t-2a49b2.
    const page = await browser.newPage();
    let surface = await openRuntimeOpsFixture(page, server.origin, "mixed", { width: 340, height: 1200 });
    await openSessionInspection(surface, RICH_INSPECTION);

    // Narrow CSS (max-width: 760px on the viewport) collapses both grids to a single track.
    const tracks = await surface.evaluate(() => {
      const setting = document.querySelector<HTMLElement>(".runtime-ops-session-setting");
      const kv = document.querySelector<HTMLElement>(".runtime-ops-session-kv > div");
      const parseTracks = (el: HTMLElement | null): number => {
        if (!el) return -1;
        const raw = getComputedStyle(el).gridTemplateColumns;
        if (!raw || raw === "none") return 0;
        return raw.split(" ").filter(Boolean).length;
      };
      return { settingTracks: parseTracks(setting), kvTracks: parseTracks(kv) };
    });
    expect(tracks.settingTracks).toBe(1);
    expect(tracks.kvTracks).toBe(1);

    expect(await hasNoHorizontalOverflow(surface)).toBe(true);
    expect(await sessionPanelContainedInFrame(surface)).toBe(true);

    // Wide counterpart: multi-column settings grid returns, still no overflow.
    surface = await openRuntimeOpsFixture(page, server.origin, "mixed", { width: 880, height: 900 });
    await openSessionInspection(surface, RICH_INSPECTION);
    const wideTracks = await surface.evaluate(() => {
      const setting = document.querySelector<HTMLElement>(".runtime-ops-session-setting");
      const raw = setting ? getComputedStyle(setting).gridTemplateColumns : "";
      return raw.split(" ").filter(Boolean).length;
    });
    expect(wideTracks).toBeGreaterThan(1);
    expect(await hasNoHorizontalOverflow(surface)).toBe(true);
    expect(await sessionPanelContainedInFrame(surface)).toBe(true);

    await page.close();
  });
});
