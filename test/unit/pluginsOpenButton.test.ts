import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-4aac93 — the card's Open door. The panel-wire test (`pluginsApp.test.ts`) is the production
 * host path; this one pins the card to `dispatch.openSurface(p.name, viewId)` so a rename of an
 * unrelated "Open" (openConfig/openDocs) cannot satisfy it.
 */
const APP = "packages/webview-ui/src/webview/plugins/App.tsx";

describe("t-4aac93 — Plugins card Open button", () => {
  it("the card Open door calls dispatch.openSurface with the plugin and a view id", () => {
    const app = readFileSync(APP, "utf8");
    expect(app).toMatch(/openSurface\(name: string, viewId\?: string\)/);
    expect(app).toMatch(/dispatch\.openSurface\(p\.name,\s*(?:s\.id|surfaces\[0\]\.id)\)/);
    expect(app).toMatch(/>Open</);
    expect(app).toMatch(/p\.surfaces/);
  });
});
