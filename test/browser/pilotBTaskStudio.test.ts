import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { STUDIO_PROTOCOL_VERSION } from "../../src/webview/shared/studio/protocol";
import type { TaskDetailEntity } from "../../src/webview/task-studio/domain";

// spec 342 T7 — Pilot B: Task Studio fields row (Kind/Priority/Assignee Kit migration).
// Drives the REAL dist/webview/task-studio.js bundle via the gate server's static root.
//
// t-1c745f (2026-07-12): after spec 350 studio-shell, the host↔webview wire is the versioned
// envelope (`type: "load" | "ready"` + `studioProtocolVersion`), NOT the pre-migration
// `{ type: "taskStudio", vm }` push. The fixture is a TaskDetailEntity (mode lives on the shell
// panel entry; assets come from bootstrapGlobals in product — optional here).

const ENTITY_NEW: TaskDetailEntity = {
  workspaceHash: "ws1",
  folder: "/tmp/demo",
  taskId: "t-000001",
  title: "",
  deps: [],
  artifact_refs: [],
  doc: { type: "doc", content: [{ type: "paragraph" }] },
  attachments: [],
  anchor: "load",
  knownAgents: ["claude", "codex"],
};

const ENTITY_EDIT: TaskDetailEntity = {
  ...ENTITY_NEW,
  taskId: "t-000002",
  title: "Existing task",
  priority: 1,
  assignee: "claude",
  // dogfood round 2 (#2) — long dep title so truncation has something real to clip.
  deps: [{ id: "t-1a2b3c", title: "Vendor shadcn/Radix components behind a Kit namespace with a legacy fallback", missing: false }],
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

/** Load the real bundle and inject a TaskDetailEntity via the studio-shell `load` message.
 *  Race-proof: re-post load until Root's message listener is mounted (ready may fire before the
 *  test installs a listener; late load is accepted once useEffect has registered). */
async function loadTaskStudio(page: Page, origin: string, entity: TaskDetailEntity): Promise<void> {
  // useEffect flushes via rAF — a background tab can stall the handshake under multi-browser load.
  await page.bringToFront();
  await page.setContent(hostPage(origin), { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.evaluate(
      (ent, protocolVersion) => {
        window.postMessage(
          {
            type: "load",
            entity: ent,
            concurrency: { kind: "none" },
            studioProtocolVersion: protocolVersion,
          },
          "*",
        );
      },
      entity,
      STUDIO_PROTOCOL_VERSION,
    );
    try {
      await page.waitForSelector(".ts-fields", { visible: true, timeout: 250 });
      return;
    } catch {
      // Root not listening yet — retry load.
    }
  }
  throw new Error("Task Studio never rendered .ts-fields after studio-protocol load messages");
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
    // excalidraw is lazy-loaded for sketch editing — not required for the fields row.
    page.on("response", (res) => {
      if (!res.ok() && !res.url().includes("excalidraw") && !res.url().endsWith("/favicon.ico")) {
        failedResponses.push(`${res.status()} ${res.url()}`);
      }
    });

    await loadTaskStudio(page, server.origin, ENTITY_NEW);

    expect(failedResponses).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it("edit-mode gating: Assignee is disabled in 'new' mode, enabled in 'edit' mode (339 behavior preserved)", async () => {
    const pageNew = await browser.newPage();
    await loadTaskStudio(pageNew, server.origin, ENTITY_NEW);
    const disabledInNew = await pageNew.$eval(".ts-fields input[placeholder='assign during triage']", (el) => (el as HTMLInputElement).disabled);
    expect(disabledInNew).toBe(true);
    await pageNew.close();

    const pageEdit = await browser.newPage();
    await loadTaskStudio(pageEdit, server.origin, ENTITY_EDIT);
    const enabledInEdit = await pageEdit.$eval(".ts-fields input[placeholder='assignee']", (el) => (el as HTMLInputElement).disabled);
    expect(enabledInEdit).toBe(false);
    await pageEdit.close();
  });

  it("KitSelect Priority: keyboard-selecting P2 updates the trigger AND can be cleared back to 'none'", async () => {
    const page = await browser.newPage();
    await loadTaskStudio(page, server.origin, ENTITY_NEW);
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

  // dogfood round 2 (#1) — parity of Priority KitSelect vs Kind in the REAL .ts-fields row.
  it("Priority KitSelect matches Kind's width/height and sits on the same row (dogfood round 2 #1)", async () => {
    const page = await browser.newPage();
    await loadTaskStudio(page, server.origin, ENTITY_NEW);

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

  // dogfood round 2 (#2) — deps chip truncates long title; full text via title tooltip.
  it("a long dep title truncates to a single-line chip with the full text as a tooltip (dogfood round 2 #2)", async () => {
    const page = await browser.newPage();
    await loadTaskStudio(page, server.origin, ENTITY_EDIT);

    const chip = await page.$eval(".ts-chip-field .chip-pill", (el) => ({
      title: el.getAttribute("title"),
      ariaLabel: el.getAttribute("aria-label"),
      height: Math.round(el.getBoundingClientRect().height),
    }));
    const text = await page.$eval(".ts-chip-field .chip-pill-text", (el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));

    expect(chip.title).toBe("t-1a2b3c · Vendor shadcn/Radix components behind a Kit namespace with a legacy fallback");
    expect(chip.ariaLabel).toBe("Remove dependency t-1a2b3c");
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(chip.height).toBeLessThan(24);
    await page.close();
  });
});
