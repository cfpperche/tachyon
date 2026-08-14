import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/**
 * A shared toolbar can advertise Sketch while its host silently omits the assets needed to render
 * SketchModal. Keep the current host list explicit: a new consumer must choose and test its panel
 * bootstrap instead of inheriting a dead button.
 */
const TOOLBAR_HOSTS = {
  "pin-studio": "src/webview/PinDetailPanel.ts",
  "task-studio": "src/webview/TaskDetailPanel.ts",
} as const;

describe("rich-doc sketch host contract", () => {
  it("every EditorToolbar host handles Sketch and injects the shared Excalidraw assets", () => {
    const webviewRoot = path.join(ROOT, "packages/webview-ui/src/webview");
    const consumers = fs.readdirSync(webviewRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        const app = path.join(webviewRoot, name, "App.tsx");
        return fs.existsSync(app) && fs.readFileSync(app, "utf8").includes("<EditorToolbar");
      })
      .sort();

    expect(consumers).toEqual(Object.keys(TOOLBAR_HOSTS).sort());

    for (const consumer of consumers) {
      const app = fs.readFileSync(path.join(webviewRoot, consumer, "App.tsx"), "utf8");
      expect(app, `${consumer} must handle toolbar Sketch`).toMatch(/<EditorToolbar\b[^>]*\bonOpenSketch=/s);
      expect(app, `${consumer} must handle slash-menu Sketch`).toMatch(/<SlashMenu\b[^>]*\bonOpenSketch=/s);
      expect(app, `${consumer} must render the shared SketchModal`).toContain("<SketchModal assets={assets}");

      const panel = fs.readFileSync(path.join(ROOT, TOOLBAR_HOSTS[consumer as keyof typeof TOOLBAR_HOSTS]), "utf8");
      expect(panel, `${consumer} panel must provide the SketchModal asset bootstrap`).toMatch(
        /bootstrapGlobals:[\s\S]*EXCALIDRAW_SCRIPT_URI:[\s\S]*EXCALIDRAW_CSS_URI:[\s\S]*EXCALIDRAW_ASSET_PATH:/,
      );
    }
  });
});
