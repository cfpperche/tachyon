import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { resolveChromeExecutable } from "../browser/support/chrome.js";
import { loadPlugin, previewInstall, applyInstall, detectRuntimes, type LoadedPlugin } from "../../apps/vscode-extension/src/plugins/engine.js";
import { PluginActionBroker, type PluginActionBrokerResult } from "../../apps/vscode-extension/src/plugins/ui/broker.js";
import { PluginFleetProjectionProvider } from "../../apps/vscode-extension/src/plugins/ui/projectionProvider.js";
import { PLUGIN_UI_ACTION, PLUGIN_UI_ACTION_RESULT, type PluginHostBootstrap } from "@tachyon/webview-ui/webview/plugin-host/relay.js";
import { renderWebviewShell } from "../../apps/vscode-extension/src/webview/shared/shell.js";
import type { FleetVM } from "@tachyon/shared/sidebar/types.js";

const ROOT = path.resolve(__dirname, "..", "..");
const EXTENSION_ROOT = path.join(ROOT, "apps", "vscode-extension");
const dirs: string[] = [];
type Browser = any;
type Page = any;
type Frame = any;

beforeAll(() => {
  if (!fs.existsSync(path.join(EXTENSION_ROOT, "dist/webview/plugin-host.js"))) {
    throw new Error("dist/webview/plugin-host.js is missing; run npm run build before the plugin UI e2e");
  }
});

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("spec 349 Phase 5 plugin UI e2e", () => {
  it("recreates a nonresponsive plugin iframe from host source-of-truth after relay teardown", async () => {
    const installed = await installFixture("spec349-mundinho");
    const broker = new PluginActionBroker({
      pluginId: installed.plugin.manifest.name,
      sessionId: "recreate-session",
      allowedActions: installed.preview.viewTargets[0].actions,
      minFocusIntervalMs: 1_000,
      randomToken: counterTokens(),
      focusAgent: () => undefined,
    });
    const stuckBootstrap = {
      ...installed.bootstrap,
      pluginHtml: "<!doctype html><html><body><h1>stuck</h1><script>window.__stuck = true;</script></body></html>",
    };
    const { server, browser, page } = await openPluginHost(stuckBootstrap);
    try {
      await pushProjection(page, broker, mundinhoFleet());
      const stuckFrame = await waitForPluginFrame(page);
      expect(await stuckFrame.evaluate(() => (globalThis as { __stuck?: boolean }).__stuck)).toBe(true);
      expect(await stuckFrame.evaluate(() => (globalThis as { document: Document }).document.querySelectorAll("button.agent").length)).toBe(0);

      server.setBootstrap(installed.bootstrap);
      const response = await page.reload({ waitUntil: "networkidle0" });
      expect(response?.ok()).toBe(true);
      await pushProjection(page, broker, mundinhoFleet());
      const recreatedFrame = await waitForPluginFrame(page);
      await recreatedFrame.waitForFunction(
        () => (globalThis as { document?: { querySelectorAll(selector: string): { length: number } } }).document?.querySelectorAll("button.agent").length === 3,
        { timeout: 5_000 },
      );
      expect(recreatedFrame).not.toBe(stuckFrame);
    } finally {
      await browser.close();
      await server.close();
    }
  });

  it("proves parent userActivation distinguishes a real srcdoc iframe click from a programmatic post", async () => {
    const installed = await installFixture("spec349-mundinho");
    const broker = new PluginActionBroker({
      pluginId: installed.plugin.manifest.name,
      sessionId: "gesture-session",
      allowedActions: installed.preview.viewTargets[0].actions,
      minFocusIntervalMs: 1_000,
      randomToken: counterTokens(),
      focusAgent: () => undefined,
    });
    const { server, browser, page } = await openPluginHost(installed.bootstrap);
    try {
      const projection = await pushProjection(page, broker, mundinhoFleet());
      const frame = await waitForPluginFrame(page);
      await frame.waitForFunction(
        () => (globalThis as { document?: { querySelectorAll(selector: string): { length: number } } }).document?.querySelectorAll("button.agent").length === 3,
        { timeout: 5_000 },
      );

      await frame.evaluate((agent: { handle: string; generation: number }) => {
        setTimeout(() => {
          parent.postMessage({
            type: "pluginUiAction",
            id: "programmatic-post",
            action: "focusAgent",
            handle: agent.handle,
            generation: agent.generation,
            userGesture: true,
          }, "*");
        }, 6_100);
      }, { handle: projection.agents[0].handle, generation: projection.generation });
      await sleep(6_250);
      const programmatic = takeHostActionMessages(await takeHostMessages(page));
      expect(programmatic).toHaveLength(1);
      expect(programmatic[0]).toMatchObject({ id: "programmatic-post", userGesture: false });

      await clickInsidePluginFrame(page, frame, 'button.agent[data-index="1"]');
      const clicked = await waitForHostActionMessages(page, 1);
      expect(clicked[0]).toMatchObject({ id: "focus-1", userGesture: true });
    } finally {
      await browser.close();
      await server.close();
    }
  });

  it("installs the adversarial fixture through the engine and proves every boundary breach fails in the real relay", async () => {
    const installed = await installFixture("spec349-adversarial");
    expect(installed.apply.installed).toBe(true);
    expect(installed.preview.viewTargets[0].actions).toEqual([]);

    const sideEffects: unknown[] = [];
    const broker = new PluginActionBroker({
      pluginId: installed.plugin.manifest.name,
      sessionId: "adversarial-session",
      allowedActions: installed.preview.viewTargets[0].actions,
      minFocusIntervalMs: 1_000,
      randomToken: counterTokens(),
      focusAgent: (target) => {
        sideEffects.push(target);
      },
    });
    const { server, browser, page } = await openPluginHost(installed.bootstrap);
    try {
      const projection = await pushProjection(page, broker, adversarialFleet());
      expect(projection.agents).toHaveLength(2);

      const frame = await waitForPluginFrame(page);
      await frame.waitForFunction(
        () => {
          const r = (globalThis as { __adversarialResults?: { network?: unknown; projection?: { received?: boolean }; actionResults?: unknown[] } }).__adversarialResults;
          return !!r?.network && r.projection?.received === true;
        },
        { timeout: 5_000 },
      );
      await drainUntil(page, broker, 11);
      await frame.waitForFunction(
        () => ((globalThis as { __adversarialResults?: { actionResults?: unknown[] } }).__adversarialResults?.actionResults ?? []).length >= 11,
        { timeout: 5_000 },
      );

      const results = await readAdversarialResults(frame);
      expect(results.parentDom).toMatchObject({ blocked: true });
      expect(results.storage).toMatchObject({ blocked: true });
      expect(results.network).toMatchObject({ blocked: true });
      expect(results.projection).toMatchObject({ received: true, count: 2, leaked: [] });
      expect(JSON.stringify(results.projection)).not.toMatch(/SENTINEL_/);

      const byId = new Map(results.actionResults.map((entry) => [entry.id, entry.result]));
      expect(byId.get("auto-focus")).toMatchObject({ ok: false, code: "action_not_allowed" });
      expect(byId.get("out-of-allowlist")).toMatchObject({ ok: false, code: "unsupported_action" });
      expect(byId.get("raw-authority")).toMatchObject({ ok: false, code: "raw_authority_rejected" });
      for (let i = 0; i < 8; i += 1) {
        expect(byId.get(`auto-flood-${i}`)).toMatchObject({ ok: false, code: "action_not_allowed" });
      }

      await clickInsidePluginFrame(page, frame, "#flood");
      await drainUntil(page, broker, 8);
      await frame.waitForFunction(
        () => ((globalThis as { __adversarialResults?: { actionResults?: unknown[] } }).__adversarialResults?.actionResults ?? []).length >= 19,
        { timeout: 5_000 },
      );
      const afterFlood = await readAdversarialResults(frame);
      for (let i = 0; i < 8; i += 1) {
        expect(new Map(afterFlood.actionResults.map((entry) => [entry.id, entry.result])).get(`click-flood-${i}`)).toMatchObject({ ok: false, code: "action_not_allowed" });
      }
      expect(sideEffects).toEqual([]);
    } finally {
      await browser.close();
      await server.close();
    }
  });

  it("installs the Mundinho fixture through the engine, renders projection characters, and brokers focusAgent on click", async () => {
    const installed = await installFixture("spec349-mundinho");
    expect(installed.apply.installed).toBe(true);
    expect(installed.preview.viewTargets[0].actions).toEqual(["focusAgent"]);

    const focused: unknown[] = [];
    const broker = new PluginActionBroker({
      pluginId: installed.plugin.manifest.name,
      sessionId: "mundinho-session",
      allowedActions: installed.preview.viewTargets[0].actions,
      minFocusIntervalMs: 1_000,
      randomToken: counterTokens(),
      focusAgent: (target) => {
        focused.push(target);
      },
    });
    const { server, browser, page } = await openPluginHost(installed.bootstrap);
    try {
      await pushProjection(page, broker, mundinhoFleet());
      const frame = await waitForPluginFrame(page);
      await frame.waitForFunction(
        () => (globalThis as { document?: { querySelectorAll(selector: string): { length: number } } }).document?.querySelectorAll("button.agent").length === 3,
        { timeout: 5_000 },
      );
      const rendered = await frame.evaluate(() => {
        const g = globalThis as { document?: { querySelectorAll(selector: string): ArrayLike<{ textContent: string | null; getAttribute(name: string): string | null }> } };
        return Array.from(g.document?.querySelectorAll("button.agent") ?? []).map((el) => ({ text: el.textContent, status: el.getAttribute("data-status") }));
      });
      expect(rendered).toEqual([
        { text: "* Agent 1", status: "running" },
        { text: "! Agent 2", status: "needs" },
        { text: "x Agent 3", status: "stopped" },
      ]);

      await clickInsidePluginFrame(page, frame, 'button.agent[data-index="1"]');
      const clickResults = await drainUntil(page, broker, 1);
      await frame.waitForFunction(
        () => ((globalThis as { __mundinhoState?: { events?: unknown[] } }).__mundinhoState?.events ?? []).length === 1,
        { timeout: 5_000 },
      );
      expect(clickResults[0]).toMatchObject({ ok: true });
      expect(focused).toEqual([{ wsHash: "mundinho-ws", agent: "needs-human" }]);
      const state = await frame.evaluate(() => (globalThis as { __mundinhoState?: unknown }).__mundinhoState);
      expect(JSON.stringify(state)).toContain('"ok":true');
    } finally {
      await browser.close();
      await server.close();
    }
  });
});

async function installFixture(name: string): Promise<{
  plugin: LoadedPlugin;
  preview: ReturnType<typeof previewInstall>;
  apply: Awaited<ReturnType<typeof applyInstall>>;
  bootstrap: PluginHostBootstrap;
}> {
  const workspace = tmp("tachyon-plugin-ui-e2e-");
  const fixtureDir = path.join(ROOT, "test", "fixtures", "plugins", name);
  const loaded = loadPlugin(fixtureDir);
  expect(loaded.errors).toEqual([]);
  expect(loaded.plugin).toBeDefined();
  const plugin = loaded.plugin as LoadedPlugin;
  const preview = previewInstall(plugin, workspace, detectRuntimes(workspace));
  expect(preview.errors).toEqual([]);
  const actionConfirmed: Record<string, true> = {};
  for (const view of preview.viewTargets) for (const action of view.actions) actionConfirmed[`${view.id}:${action}`] = true;
  const apply = await applyInstall(plugin, preview, workspace, detectRuntimes(workspace), {
    viewConfirmed: true,
    fleetReadConfirmed: true,
    actionConfirmed,
  });
  expect(apply.errors).toEqual([]);
  const view = preview.viewTargets[0];
  return {
    plugin,
    preview,
    apply,
    bootstrap: {
      pluginId: plugin.manifest.name,
      viewId: view.id,
      title: view.title,
      pluginHtml: fs.readFileSync(path.join(workspace, view.fileRel), "utf8"),
    },
  };
}

async function openPluginHost(bootstrap: PluginHostBootstrap): Promise<{ server: PluginHostServer; browser: Browser; page: Page }> {
  const server = await startPluginHostServer(bootstrap);
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    const g = globalThis as {
      __hostMessages?: unknown[];
      __takeHostMessages?: () => unknown[];
      addEventListener(type: string, listener: (event: { source: unknown; data: unknown }) => void): void;
    };
    g.__hostMessages = [];
    g.__takeHostMessages = () => g.__hostMessages?.splice(0) ?? [];
    g.addEventListener("message", (event) => {
      if (event.source === g && event.data && typeof event.data === "object") {
        g.__hostMessages?.push(event.data);
      }
    });
  });
  const response = await page.goto(server.url, { waitUntil: "networkidle0" });
  expect(response?.ok()).toBe(true);
  return { server, browser, page };
}

async function pushProjection(page: Page, broker: PluginActionBroker, fleet: FleetVM): Promise<ReturnType<PluginFleetProjectionProvider["refresh"]>> {
  let message: unknown;
  const provider = new PluginFleetProjectionProvider({ postMessage: (value) => { message = value; return true; } }, broker.mintHandle);
  const projection = provider.refresh(fleet);
  await page.evaluate((value: unknown) => {
    const g = globalThis as { dispatchEvent(event: Event): boolean; MessageEvent: typeof MessageEvent };
    g.dispatchEvent(new g.MessageEvent("message", { data: value }));
  }, message);
  return projection;
}

async function drainActions(page: Page, broker: PluginActionBroker): Promise<PluginActionBrokerResult[]> {
  const messages = await takeHostMessages(page);
  const results: PluginActionBrokerResult[] = [];
  for (const message of messages) {
    if (!isActionMessage(message)) continue;
    const result = await broker.dispatchAction(message);
    results.push(result);
    await page.evaluate(
      (payload: unknown) => {
        const g = globalThis as { dispatchEvent(event: Event): boolean; MessageEvent: typeof MessageEvent };
        g.dispatchEvent(new g.MessageEvent("message", { data: payload }));
      },
      { type: PLUGIN_UI_ACTION_RESULT, id: message.id, result },
    );
  }
  return results;
}

async function drainUntil(page: Page, broker: PluginActionBroker, expected: number): Promise<PluginActionBrokerResult[]> {
  const out: PluginActionBrokerResult[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && out.length < expected) {
    out.push(...await drainActions(page, broker));
    if (out.length >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(out.length).toBeGreaterThanOrEqual(expected);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function takeHostMessages(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const g = globalThis as { __takeHostMessages?: () => unknown[] };
    return g.__takeHostMessages?.() ?? [];
  });
}

async function waitForHostActionMessages(page: Page, expected: number): Promise<Array<{ type: typeof PLUGIN_UI_ACTION; id?: unknown; action?: unknown; handle?: unknown; generation?: unknown; userGesture?: unknown }>> {
  const out: Array<{ type: typeof PLUGIN_UI_ACTION; id?: unknown; action?: unknown; handle?: unknown; generation?: unknown; userGesture?: unknown }> = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && out.length < expected) {
    out.push(...takeHostActionMessages(await takeHostMessages(page)));
    if (out.length >= expected) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(out.length).toBeGreaterThanOrEqual(expected);
  return out;
}

function takeHostActionMessages(messages: unknown[]): Array<{ type: typeof PLUGIN_UI_ACTION; id?: unknown; action?: unknown; handle?: unknown; generation?: unknown; userGesture?: unknown }> {
  return messages.filter(isActionMessage);
}

function isActionMessage(value: unknown): value is { type: typeof PLUGIN_UI_ACTION; id?: unknown; action?: unknown; handle?: unknown; generation?: unknown; userGesture?: unknown } {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === PLUGIN_UI_ACTION;
}

async function waitForPluginFrame(page: Page): Promise<Frame> {
  await page.waitForFunction(() => {
    const g = globalThis as { document?: { querySelector(selector: string): unknown } };
    return !!g.document?.querySelector("iframe.plugin-host-frame");
  }, { timeout: 5_000 });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate: { url(): string }) => candidate.url() === "about:srcdoc");
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("plugin srcdoc frame did not attach");
}

async function clickInsidePluginFrame(page: Page, frame: Frame, selector: string): Promise<void> {
  const iframeBox = await page.$eval("iframe.plugin-host-frame", (el: unknown) => {
    const rect = (el as unknown as { getBoundingClientRect(): { left: number; top: number } }).getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  const targetBox = await frame.$eval(selector, (el: unknown) => {
    const rect = (el as unknown as { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(iframeBox.x + targetBox.x, iframeBox.y + targetBox.y);
}

async function readAdversarialResults(frame: Frame): Promise<{
  parentDom: { blocked: boolean };
  storage: { blocked: boolean };
  network: { blocked: boolean };
  projection: { received: boolean; count: number; leaked: string[] };
  actionResults: Array<{ id: string; result: PluginActionBrokerResult }>;
}> {
  return frame.evaluate(() => (globalThis as unknown as { __adversarialResults: never }).__adversarialResults);
}

function adversarialFleet(): FleetVM {
  return {
    folder: { hash: "SENTINEL_WS_HASH", name: "workspace" },
    bridge: { port: "SENTINEL_BRIDGE_PORT", connected: true },
    agents: [
      poisonedAgent("SENTINEL_AGENT_NAME", "running"),
      poisonedAgent("second-agent", "needs"),
    ],
    terminals: [],
    commands: [{ name: "cmd", cmd: "SENTINEL_COMMAND", state: "idle", detail: "SENTINEL_COMMAND" }],
    runbooks: [{ name: "runbook", running: false, failed: false, detail: "SENTINEL_RUNBOOK", steps: [{ n: 1, label: "SENTINEL_RUNBOOK", state: "skipped" }] }],
    pins: [{ id: "pin", text: "SENTINEL_PIN", by: "human", done: false, tags: ["SENTINEL_PIN"], detail: false, attachmentCount: 0 }],
    proposals: [{ id: "proposal", name: "SENTINEL_AGENT_NAME", reason: "SENTINEL_PROPOSAL", when: "now" }],
    schedules: [],
    pipelines: [],
    handoff: { exists: true, staleness: "needs_distill", pendingCount: 1 },
  };
}

function mundinhoFleet(): FleetVM {
  return {
    folder: { hash: "mundinho-ws", name: "workspace" },
    bridge: { port: "-", connected: true },
    agents: [
      { name: "runner", status: "running", kind: "agent" },
      { name: "needs-human", status: "needs", attention: "needs-input", kind: "agent" },
      { name: "parked", status: "stopped", kind: "agent" },
    ],
    terminals: [],
    commands: [],
    runbooks: [],
    pins: [],
    schedules: [],
    pipelines: [],
  };
}

function poisonedAgent(name: string, status: "running" | "needs"): FleetVM["agents"][number] {
  return {
    name,
    status,
    attention: status === "needs" ? "needs-input" : "working",
    worktree: "SENTINEL_WORKTREE",
    parent: "SENTINEL_PARENT",
    sub: "SENTINEL_COMMAND",
    persistenceHooks: { state: "active", path: "SENTINEL_HOOK_PATH" },
    kind: "agent",
  } as FleetVM["agents"][number];
}

function counterTokens(): () => string {
  let i = 0;
  return () => `handle_${++i}`;
}

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface PluginHostServer {
  url: string;
  setBootstrap(bootstrap: PluginHostBootstrap): void;
  close(): Promise<void>;
}

async function startPluginHostServer(bootstrap: PluginHostBootstrap): Promise<PluginHostServer> {
  let currentBootstrap = bootstrap;
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/plugin-host") {
      const origin = `http://${req.headers.host}`;
      const html = renderWebviewShell({
        cspSource: origin,
        title: bootstrap.title,
        styles: [],
        bundle: `${origin}/dist/webview/plugin-host.js`,
        mode: "live",
        frameSrc: "self",
        scriptCspSource: false,
        bootstrapGlobals: { __tachyonPluginHost: currentBootstrap },
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    const filePath = path.resolve(EXTENSION_ROOT, "." + urlPath);
    const rel = path.relative(EXTENSION_ROOT, filePath);
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": urlPath.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/plugin-host`,
    setBootstrap: (next) => {
      currentBootstrap = next;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
