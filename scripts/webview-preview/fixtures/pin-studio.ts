/**
 * spec 278 — Pin Studio fixtures for the dev preview harness (the last view onboarded). Provenance:
 * `synthetic-edge` — typed against the real PinStudioVM. The tiptap editor renders from the VM; excalidraw is
 * lazy (loaded only on sketch-edit interaction), so the harness renders the editor without the asset bootstrap.
 */

import type { PinStudioVM } from "../../../src/webview/pin-studio/types";
import type { Fixture } from "../routes";

const assets = {
  excalidrawScriptUri: "/dist/webview/excalidraw.js",
  excalidrawCssUri: "/dist/webview/excalidraw.css",
  excalidrawAssetPath: "/dist/webview/",
};

const editPin: PinStudioVM = {
  workspaceHash: "a1b2c3",
  folder: "tachyon",
  mode: "edit",
  pinId: "pin-7f3a",
  title: "Redesign the agent header",
  tags: ["ui", "spec-280"],
  doc: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "The sidebar header badges crowd at narrow widths." }] },
      { type: "paragraph", content: [{ type: "text", text: "Tighten the gap and align the codicons with their labels." }] },
    ],
  },
  attachments: [],
  assets,
};

const newPin: PinStudioVM = { workspaceHash: "a1b2c3", folder: "tachyon", mode: "new", title: "", tags: [], doc: null, attachments: [], assets };

export const pinStudioFixtures: Record<string, Fixture<PinStudioVM>> = {
  default: { provenance: "synthetic-edge", vm: editPin },
  new: { provenance: "synthetic-edge", vm: newPin },
};
