/**
 * spec 279 — Pin Preview fixtures for the dev preview harness. Provenance: `synthetic-edge` — typed against
 * the real PinPreviewVM. The `hostile` fixture carries injection payloads in user fields (title/body/tags/
 * attachment name) to PROVE preact renders them as inert TEXT (the security contract for flipping scripts on).
 */

import type { PinPreviewVM } from "@tachyon/shared/sidebar/types";
import type { Fixture } from "../routes";

export const HOSTILE_TITLE = `<img src=x onerror="alert(1)">`;
export const HOSTILE_BODY = `<script>alert('xss')</script>\n\nsecond <b>paragraph</b> with javascript:alert(2)`;

const normal: PinPreviewVM = {
  id: "pin-7f3a",
  title: "Redesign the agent header",
  by: "carlos",
  done: false,
  tags: ["ui", "spec-279"],
  body: "The sidebar header badges crowd at narrow widths.\n\nTighten the gap + align the codicons with their labels.",
  doc: null,
  attachments: [
    { id: "a1", kind: "image", name: "before.png", available: true, uri: "https://example.invalid/before.png", detail: "PNG · 84 KB" },
    { id: "a2", kind: "excalidraw", name: "layout.excalidraw", available: false, detail: "Sketch · 12 elements · 0 KB preview" },
  ],
};

// every user-controlled field is an injection payload; preact must render them as literal text.
const hostile: PinPreviewVM = {
  id: "pin-evil",
  title: HOSTILE_TITLE,
  done: false,
  tags: [`<svg onload=alert(3)>`],
  body: HOSTILE_BODY,
  doc: null,
  attachments: [{ id: "x", kind: "image", name: `"><img src=x onerror=alert(4)>`, available: false, detail: "n/a" }],
};

// t-321e9d — the regression fixture: a rich doc with an inline image node whose attachment resolves. Proves
// the body renders a real `<img>` (not the flattened "[Image]" text placeholder) while the Visuals aside
// keeps showing its own thumbnail, same as before.
const withImage: PinPreviewVM = {
  id: "pin-c429fb",
  title: "Board header dogfood screenshot",
  by: "human",
  done: false,
  tags: ["dogfood"],
  body: "[Image]",
  doc: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "See the screenshot below." }] },
      { type: "image", attrs: { attachmentId: "att-shot", blobRef: "shot-blob" } },
    ],
  },
  attachments: [
    { id: "att-shot", kind: "image", name: "shot.png", available: true, uri: "https://example.invalid/shot.png", detail: "PNG · 42 KB" },
  ],
};

export const pinPreviewFixtures: Record<string, Fixture<PinPreviewVM>> = {
  default: { provenance: "synthetic-edge", vm: normal },
  hostile: { provenance: "synthetic-edge", vm: hostile },
  "with-image": { provenance: "synthetic-edge", vm: withImage },
};
