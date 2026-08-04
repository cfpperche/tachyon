import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { STUDIO_PROTOCOL_VERSION } from "../../src/webview/shared/studio/protocol";
import type { TaskDetailEntity } from "../../src/webview/task-studio/domain";

// spec 342 T7 — Pilot B: Task Studio fields row (Kind/Priority/Assignee Kit migration).
//
// t-1c745f (2026-07-12): after spec 350 studio-shell, the host↔webview wire is the versioned
// envelope (`type: "load" | "ready"` + `studioProtocolVersion`), NOT the pre-migration
// `{ type: "taskStudio", vm }` push. The fixture is a TaskDetailEntity (mode lives on the shell
// panel entry; assets come from bootstrapGlobals in product — optional here).
//
// D12 (2026-08-04): Task Studio is edit mode of the task-detail document, so the production door is
// the task-detail bundle and its edit fixture — never Control and never a second panel. The
// `load` injection below is UNCHANGED and still the thing under test: the mounted studio keeps
// listening for the versioned envelope, so each test still drives its OWN entity (new vs edit, long
// dep title, long artifact paths) rather than whatever the catalog fixture happens to hold.

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

const PREVIEW = "/scripts/webview-preview/index.html?view=task-detail&fixture=edit";

/** Open the studio route on the real bundle, then inject a TaskDetailEntity via the studio-shell
 *  `load` message — the entity the test wants, replacing the catalog fixture the route mounted with.
 *  Race-proof: re-post load until Root's message listener is mounted (ready may fire before the
 *  test installs a listener; late load is accepted once useEffect has registered). */
async function loadTaskStudio(page: Page, origin: string, entity: TaskDetailEntity): Promise<void> {
  // useEffect flushes via rAF — a background tab can stall the handshake under multi-browser load.
  await page.bringToFront();
  await page.goto(`${origin}${PREVIEW}`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".ts-fields", { visible: true, timeout: 15_000 });

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
      // The route already mounted SOME entity (the catalog fixture), so ".ts-fields exists" no longer
      // proves the injection landed — wait for the title field to carry THIS entity's title instead.
      await page.waitForFunction(
        (title) => document.querySelector<HTMLInputElement>("input.rd-title")?.value === title,
        { timeout: 250 },
        entity.title,
      );
      return;
    } catch {
      // Root not listening yet — retry load.
    }
  }
  throw new Error("Task Studio never adopted the injected entity after studio-protocol load messages");
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

  // t-dd22e8 — artifact chips with long paths must not overflow/overlap; same ellipsis shell as deps.
  it("t-dd22e8: long artifact paths truncate without overlapping sibling chips", async () => {
    const page = await browser.newPage();
    const longPath = "/mnt/c/Users/cfpp/Pictures/Screenshots/Screenshot 2026-07-12 210316.png";
    await loadTaskStudio(page, server.origin, {
      ...ENTITY_EDIT,
      artifact_refs: [
        { type: "screenshot", ref: longPath },
        { type: "relation", ref: "t-f87651" },
        { type: "relation", ref: "docs/specs/370-runtime-launch-preflight" },
      ],
    });

    // Narrow viewport forces the Artifacts column to share a tight width (repro-like).
    await page.setViewport({ width: 720, height: 900 });

    const artifactsField = await page.$('[aria-label="Artifact refs"]');
    expect(artifactsField).toBeTruthy();
    const metrics = await page.$eval('[aria-label="Artifact refs"]', (field) => {
      const pills = [...field.querySelectorAll(".chip-pill")] as HTMLElement[];
      const fieldRect = field.getBoundingClientRect();
      const boxes = pills.map((el) => {
        const r = el.getBoundingClientRect();
        const text = el.querySelector(".chip-pill-text") as HTMLElement | null;
        return {
          title: el.getAttribute("title") ?? "",
          top: r.top,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          height: r.height,
          width: r.width,
          overflowX: r.right > fieldRect.right + 1,
          textOverflow: text ? text.scrollWidth > text.clientWidth + 1 : false,
        };
      });
      // Any pair of pills whose rectangles overlap in both axes is a visual collision.
      let overlap = false;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const xHit = a.left < b.right - 1 && a.right > b.left + 1;
          const yHit = a.top < b.bottom - 1 && a.bottom > b.top + 1;
          if (xHit && yHit) overlap = true;
        }
      }
      return {
        count: pills.length,
        fieldWidth: fieldRect.width,
        overlap,
        boxes,
        hasTextShell: pills.every((el) => !!el.querySelector(".chip-pill-text")),
      };
    });

    expect(metrics.count).toBe(3);
    expect(metrics.hasTextShell).toBe(true);
    expect(metrics.overlap).toBe(false);
    expect(metrics.boxes.every((b) => !b.overflowX)).toBe(true);
    expect(metrics.boxes.every((b) => b.height < 28)).toBe(true);
    const longChip = metrics.boxes.find((b) => b.title.includes(longPath));
    expect(longChip).toBeTruthy();
    expect(longChip!.title).toBe(`screenshot:${longPath}`);
    expect(longChip!.textOverflow).toBe(true);
    expect(longChip!.width).toBeLessThanOrEqual(220);
    await page.close();
  });
});
