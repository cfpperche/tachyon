/**
 * spec 278 / t-610705 (Phase D, D3) — Pin Studio fixtures for the dev preview harness, migrated onto
 * the studio shell's protocol (`load`/`error` envelopes) the same way task-studio's fixtures were
 * (see fixtures/task-studio.ts) when Pin Studio became a Control studio route. Typed against the real
 * PinDetailEntity (the shape PinStudioAdapter.load() actually returns) — NOT the old standalone
 * panel's PinStudioVM (which embedded `mode`/`assets` fields the new protocol derives elsewhere:
 * `mode` from entityId presence, `assets` from Cockpit.ts's bootstrapGlobals).
 */

import type { PinDetailEntity } from "../../../src/webview/pin-studio/domain";
import type { Fixture } from "../routes";

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

interface PinStudioFixtureVM {
  entity: PinDetailEntity;
  loadError?: { code: string; message: string };
}

export function pinStudioMakeMessage(vm: PinStudioFixtureVM): unknown[] {
  if (vm.loadError) {
    return [envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true })];
  }
  return [envelope({ type: "load", entity: vm.entity, concurrency: { kind: "none" }, saveInFlight: false })];
}

const editPin: PinDetailEntity = {
  workspaceHash: "a1b2c3",
  folder: "tachyon",
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
};

const newPin: PinDetailEntity = { workspaceHash: "a1b2c3", folder: "tachyon", title: "", tags: [], doc: null, attachments: [] };

export const pinStudioFixtures: Record<string, Fixture<PinStudioFixtureVM>> = {
  default: { provenance: "synthetic-edge", vm: { entity: editPin } },
  // t-610705 (Phase D, D3) — same "dense-edit" key convention every other studio's fixtures module
  // provides (the cockpit route's byStudio dispatch selects "dense-edit" for a studio-edit route).
  "dense-edit": { provenance: "synthetic-edge", vm: { entity: editPin } },
  new: { provenance: "synthetic-edge", vm: { entity: newPin } },
};
