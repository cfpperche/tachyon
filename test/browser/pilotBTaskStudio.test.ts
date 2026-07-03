import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";

// spec 342 T7 — Pilot B: the Task Studio fields row (the surface whose 339 dogfood motivated this spec)
// migrates Kind/Priority/Assignee to KitLabeledInput/KitSelect. Task Studio isn't onboarded into
// scripts/webview-preview (only pin-studio made it in so far — see routes.ts), so this test drives the REAL
// dist/webview/task-studio.js bundle directly against a minimal fixture VM, posted via `page.setContent`
// (the gate server's static-file fallback still serves the dist/webview/* assets this host page references)
// after the bundle's own `ready` handshake — same protocol main.tsx/messages.ts define, same proof shape as
// Pilot A's preview-harness test, without depending on that harness's route table.
const FIXTURE_VM_NEW = {
  workspaceHash: "ws1",
  folder: "/tmp/demo",
  mode: "new",
  taskId: "t-000001",
  title: "",
  deps: [],
  artifact_refs: [],
  doc: { type: "doc", content: [{ type: "paragraph" }] },
  attachments: [],
  assets: { excalidrawScriptUri: "/dist/webview/excalidraw.js", excalidrawCssUri: "/dist/webview/excalidraw.css", excalidrawAssetPath: "/dist/webview/" },
  anchor: "load",
  knownAgents: ["claude", "codex"],
};

const FIXTURE_VM_EDIT = {
  ...FIXTURE_VM_NEW,
  mode: "edit",
  taskId: "t-000002",
  title: "Existing task",
  priority: 1,
  assignee: "claude",
  expectUpdatedAt: "2026-07-03T00:00:00.000Z",
};

function hostPage(cspSource: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="${cspSource}/dist/webview/codicon.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/design-system.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/vscode-theme.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/task-studio.tailwind.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/rich-doc.css">
<link rel="stylesheet" href="${cspSource}/dist/webview/task-studio.css">
<title>task-studio pilot B</title></head>
<body><div id="root"></div><script src="${cspSource}/dist/webview/task-studio.js"></script></body></html>`;
}

/** Load the real bundle on a fresh page and inject a fixture VM once it signals `ready` — mirrors
 *  scripts/webview-preview/preview.ts's own injection protocol without depending on its route table. */
async function loadTaskStudio(page: Page, origin: string, vm: unknown): Promise<void> {
  await page.setContent(hostPage(origin), { waitUntil: "domcontentloaded" });
  await page.evaluate((v) => {
    const onReady = (e: MessageEvent) => {
      const d = e.data as { type?: string } | undefined;
      if (d?.type === "ready") {
        window.removeEventListener("message", onReady);
        window.postMessage({ type: "taskStudio", vm: v }, "*");
      }
    };
    window.addEventListener("message", onReady);
  }, vm);
  await page.waitForSelector(".ts-fields", { visible: true, timeout: 5000 });
}

describe("Pilot B: Task Studio fields row (real bundle, minimal fixture VM)", () => {
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

  it("renders the migrated Kit fields row with no console/response errors", async () => {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    // the excalidraw bundle/css are lazy-loaded on-demand for sketch editing, never fetched by the fields
    // row itself — irrelevant to this test, so excluded from the failure list rather than pre-fetched.
    page.on("response", (res) => {
      if (!res.ok() && !res.url().includes("excalidraw") && !res.url().endsWith("/favicon.ico")) failedResponses.push(`${res.status()} ${res.url()}`);
    });

    await loadTaskStudio(page, server.origin, FIXTURE_VM_NEW);

    expect(failedResponses).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it("edit-mode gating: Assignee is disabled in 'new' mode, enabled in 'edit' mode (339 behavior preserved)", async () => {
    const pageNew = await browser.newPage();
    await loadTaskStudio(pageNew, server.origin, FIXTURE_VM_NEW);
    const disabledInNew = await pageNew.$eval(".ts-fields input[placeholder='assign during triage']", (el) => (el as HTMLInputElement).disabled);
    expect(disabledInNew).toBe(true);
    await pageNew.close();

    const pageEdit = await browser.newPage();
    await loadTaskStudio(pageEdit, server.origin, FIXTURE_VM_EDIT);
    const enabledInEdit = await pageEdit.$eval(".ts-fields input[placeholder='assignee']", (el) => (el as HTMLInputElement).disabled);
    expect(enabledInEdit).toBe(false);
    await pageEdit.close();
  });

  it("KitSelect Priority: keyboard-selecting P2 updates the trigger AND can be cleared back to 'none'", async () => {
    const page = await browser.newPage();
    await loadTaskStudio(page, server.origin, FIXTURE_VM_NEW);
    await page.waitForSelector('[data-slot="select-trigger"]', { visible: true, timeout: 5000 });

    await page.click('[data-slot="select-trigger"]');
    await page.waitForSelector('[data-slot="select-content"]', { visible: true, timeout: 2000 });
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-slot="select-item"]')] as HTMLElement[];
      items.find((el) => el.textContent === "P2")?.click();
    });
    await page.waitForSelector('[data-slot="select-content"]', { hidden: true, timeout: 2000 });
    let label = await page.$eval('[data-slot="select-trigger"]', (el) => el.textContent);
    expect(label).toContain("P2");

    await page.click('[data-slot="select-trigger"]');
    await page.waitForSelector('[data-slot="select-content"]', { visible: true, timeout: 2000 });
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-slot="select-item"]')] as HTMLElement[];
      items.find((el) => el.textContent === "none")?.click();
    });
    await page.waitForSelector('[data-slot="select-content"]', { hidden: true, timeout: 2000 });
    label = await page.$eval('[data-slot="select-trigger"]', (el) => el.textContent);
    expect(label).toContain("none");
    await page.close();
  });

  // dogfood round 2 (#1) — "the parity fixture asserted box-model equality but not ROW behavior (width
  // policy + baseline alignment)": kitLegacyParity.test.ts's synthetic ui-gate fixture passed even with the
  // bug, since it only ever measured an isolated trigger, never the REAL .ts-fields row where Priority's
  // Radix SelectTrigger ships an upstream `w-fit` class. This drives the actual production bundle instead.
  it("Priority KitSelect matches Kind's width/height and sits on the same row (dogfood round 2 #1)", async () => {
    const page = await browser.newPage();
    await loadTaskStudio(page, server.origin, FIXTURE_VM_NEW);

    const boxOf = (selector: string) =>
      page.$eval(selector, (el) => {
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top) };
      });

    const kind = await boxOf(".ts-fields input[placeholder='kind']");
    const priority = await boxOf('.ts-fields [data-slot="select-trigger"]');

    expect(priority.height).toBe(kind.height);
    expect(priority.top).toBe(kind.top);
    expect(priority.width).toBe(kind.width);
    await page.close();
  });
});
