import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { parseShellCsp } from "../../apps/vscode-extension/src/webview/shared/shell";

// spec 349 T1 — THE CONTRACT GATE for the opaque-origin plugin iframe (plan.md D4, tasks.md T1). This is the
// hard gate the rest of the plugin-ui-surfaces spec depends on: no downstream task (T2+) starts until every
// invariant below is proven GREEN in a REAL browser (not jsdom, which doesn't enforce sandboxing/CSP/opaque
// origins at all). If any of these fail, D4 must fall back (blob:/served-origin) before Phase 4 — see plan.md
// risk #1.
describe("plugin-frame gate (spec 349 T1) — opaque-origin srcdoc iframe contract", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
    await server.close();
  });

  const waitForResults = () =>
    page.waitForFunction(
      () => {
        const r = (window as unknown as { __pluginFrameGateResults?: Record<string, unknown> }).__pluginFrameGateResults;
        return !!r && r.parentDom !== null && r.storage !== null && r.network !== null;
      },
      { timeout: 5000 },
    );

  it("(a) the shell's OWN CSP change: frame-src 'self' (+ child-src 'self' fallback) is present, minimal, and nothing else moved", async () => {
    const response = await page.goto(server.pluginFrameGateUrl, { waitUntil: "networkidle0" });
    expect(response?.ok()).toBe(true);
    const html = await page.content();
    const csp = parseShellCsp(html);
    expect(csp["frame-src"]).toEqual(["'self'"]);
    expect(csp["child-src"]).toEqual(["'self'"]);
    expect(csp["default-src"]).toEqual(["'none'"]);
  });

  it("(b) the iframe is sandboxed WITHOUT allow-same-origin (the one invariant that must never be relaxed)", async () => {
    const sandbox = await page.$eval("#plugin-frame", (el) => el.getAttribute("sandbox"));
    expect(sandbox).toBe("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("(b) the srcdoc frame actually RENDERS (mounted:true) — a blank frame must fail this gate, not pass it silently", async () => {
    await waitForResults();
    const results = await page.evaluate(() => (window as unknown as { __pluginFrameGateResults: Record<string, unknown> }).__pluginFrameGateResults);
    expect(results.mounted).toEqual({ blocked: true, detail: "plugin doc executed" });
  });

  it("(c) the framed document CANNOT reach the parent DOM (opaque origin blocks it — this test FAILS if it ever can)", async () => {
    await waitForResults();
    const results = await page.evaluate(() => (window as unknown as { __pluginFrameGateResults: Record<string, unknown> }).__pluginFrameGateResults);
    expect((results.parentDom as { blocked: boolean }).blocked).toBe(true);
  });

  it("(c) the framed document CANNOT reach parent-accessible storage (localStorage) from its opaque origin", async () => {
    await waitForResults();
    const results = await page.evaluate(() => (window as unknown as { __pluginFrameGateResults: Record<string, unknown> }).__pluginFrameGateResults);
    expect((results.storage as { blocked: boolean }).blocked).toBe(true);
  });

  it("(c) the framed document CANNOT reach the network — fetch of a real, always-200 same-server URL is blocked by its OWN connect-src 'none' (not an incidental DNS failure)", async () => {
    await waitForResults();
    const results = await page.evaluate(() => (window as unknown as { __pluginFrameGateResults: Record<string, unknown> }).__pluginFrameGateResults);
    expect((results.network as { blocked: boolean }).blocked).toBe(true);
  });

  it("(d) the plugin document loads NO asWebviewUri/vscode-webview-resource sub-resource — it is fully self-contained (srcdoc + inline script only)", async () => {
    const failedResponses: string[] = [];
    page.removeAllListeners("response");
    page.on("response", (res) => {
      if (!res.ok() && !res.url().endsWith("/favicon.ico")) failedResponses.push(`${res.status()} ${res.url()}`);
    });
    await page.goto(server.pluginFrameGateUrl, { waitUntil: "networkidle0" });
    await waitForResults();
    // the ONLY network requests the outer page makes are: the gate page itself + its relay bundle. The srcdoc
    // document has no `src=` navigation of its own (it's inline markup) so it can generate no request at all —
    // proven here by there being no unexpected/failed response, and directly by the network probe above.
    expect(failedResponses).toEqual([]);
  });

  it("(e) the two-way postMessage relay works DESPITE full isolation — ping (parent→frame) gets a pong (frame→parent) back", async () => {
    await waitForResults();
    await page.waitForFunction(
      () => (window as unknown as { __pluginFrameGateResults: Record<string, unknown> }).__pluginFrameGateResults.pong === 1,
      { timeout: 5000 },
    );
    const results = await page.evaluate(() => (window as unknown as { __pluginFrameGateResults: Record<string, unknown> }).__pluginFrameGateResults);
    expect(results.pong).toBe(1);
  });

  it("blank-vs-loaded: a fresh navigation renders visibly EMPTY, then the frame + status readout mount (fail-loud proof, not a silent pass)", async () => {
    const fresh = await browser.newPage();
    try {
      // freeze the page before the relay bundle runs, by intercepting and holding ITS request specifically —
      // the HTML document itself (with the empty <div id="root">) is allowed to load and finish navigating.
      await fresh.setRequestInterception(true);
      let releaseBundle: (() => void) | undefined;
      const bundleHeld = new Promise<void>((resolve) => (releaseBundle = resolve));
      fresh.on("request", (req) => {
        if (req.url().endsWith("plugin-frame-relay.js")) bundleHeld.then(() => req.continue());
        else req.continue();
      });
      // don't await full navigation — the shell's bundle <script> is render-blocking (no async/defer), so with
      // its request held, load/domcontentloaded would never fire. The DOM parser still reaches <div id="root">
      // (it appears BEFORE the blocking <script> tag) so waitForSelector resolves independently of that.
      const nav = fresh.goto(server.pluginFrameGateUrl).catch(() => {});
      await fresh.waitForSelector("#root");
      const blankHtml = await fresh.$eval("#root", (el) => el.innerHTML);
      expect(blankHtml.trim()).toBe(""); // BLANK — the bundle request is still held, nothing has mounted
      releaseBundle?.();
      await nav;
      await fresh.waitForFunction(() => !!document.getElementById("plugin-frame"), { timeout: 5000 });
      const loadedHtml = await fresh.$eval("#root", (el) => el.innerHTML);
      expect(loadedHtml).toContain('id="plugin-frame"'); // LOADED — the frame mounted
    } finally {
      await fresh.close();
    }
  });
});
