import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSectionStylesheet } from "../../src/webview/shared/lazySectionStyles.js";

// t-610705 (SDD 410 Phase B, Approvals CSS co-load pilot) — this repo's default vitest environment
// is "node" (no jsdom/happy-dom), so stub the minimal document/window surface the module touches
// rather than pull in a DOM environment for one function.
interface FakeLink { rel: string; href: string }
interface FakeDocument { createElement(tag: string): FakeLink; head: { appendChild(node: FakeLink): void } }

describe("loadSectionStylesheet (t-610705)", () => {
  let appended: FakeLink[];
  let fakeDocument: FakeDocument;

  // The module's dedupe Set is keyed by href and lives for the module's lifetime (correct for a
  // real webview process — never needs resetting there). Give each test a unique href so the
  // module-level cache from an earlier test in this file can't shadow the one under test.
  let href: string;
  let testCounter = 0;

  beforeEach(() => {
    appended = [];
    testCounter += 1;
    href = `vscode-webview://x/approval-${testCounter}.css`;
    fakeDocument = {
      createElement: () => ({ rel: "", href: "" }),
      head: { appendChild: (node) => { appended.push(node); } },
    };
    (globalThis as { document?: unknown }).document = fakeDocument;
    (globalThis as { window?: unknown }).window = { __tachyonSectionStyles: { approvals: href } };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });

  it("injects a stylesheet link for a section with a registered URI", () => {
    loadSectionStylesheet("approvals");
    expect(appended).toEqual([{ rel: "stylesheet", href }]);
  });

  it("is idempotent — a second call for the same section does not append twice", () => {
    loadSectionStylesheet("approvals");
    loadSectionStylesheet("approvals");
    expect(appended).toHaveLength(1);
  });

  it("no-ops for a section with no registered stylesheet URI (e.g. the eagerly-loaded active section)", () => {
    loadSectionStylesheet("mission");
    expect(appended).toHaveLength(0);
  });

  it("no-ops when window.__tachyonSectionStyles itself is absent (older bootstrap, non-cockpit host)", () => {
    (globalThis as { window: { __tachyonSectionStyles?: unknown } }).window.__tachyonSectionStyles = undefined;
    loadSectionStylesheet("approvals");
    expect(appended).toHaveLength(0);
  });

  // t-610705 — Runtime Ops is the second surface to adopt this mechanism; the bootstrap global now
  // carries multiple section→URI entries. Each section's injection is independent of the others.
  it("resolves the right URI when multiple sections are registered on the same bootstrap map", () => {
    const runtimeHref = "vscode-webview://x/runtime-ops.css";
    (globalThis as { window: { __tachyonSectionStyles: Record<string, string> } }).window.__tachyonSectionStyles = {
      approvals: href,
      runtime: runtimeHref,
    };
    loadSectionStylesheet("runtime");
    expect(appended).toEqual([{ rel: "stylesheet", href: runtimeHref }]);
  });
});
