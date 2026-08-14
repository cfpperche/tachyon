/**
 * SDD 485 C1–C3 — preview fixtures for the section-app proof surface.
 *
 * What the harness renders here is the MECHANISM, so the fixtures are the mechanism's interesting states
 * rather than domain data: a document panel with an identity, a second identity (the "side by side" claim,
 * seen one frame at a time), a dashboard panel with no identity at all, and the state after a reveal
 * rebuilt the panel from scratch instead of letting it come back stale.
 *
 * The VMs go through the surface's own message constructor, so an envelope change breaks this build rather
 * than producing a silently wrong screenshot (spec 278's drift guard).
 */

import { sectionFixtureModelMessage } from "@tachyon/webview-ui/webview/section-app-fixture/protocol";
import type { SectionFixtureModel } from "@tachyon/webview-ui/webview/section-app-fixture/protocol";
import type { Fixture, Route } from "../routes";

export function sectionAppFixtureMakeMessage(vm: SectionFixtureModel): unknown {
  return sectionFixtureModelMessage(vm);
}

const document1: SectionFixtureModel = {
  app: "section-app-fixture",
  cardinality: "document",
  key: "tachyonSectionAppFixture|ws-4f21|t-363b80",
  project: "ws-4f21",
  identity: "t-363b80",
  revision: 1,
  lastPush: "replay",
};

export const sectionAppFixtureFixtures: Record<string, Fixture<SectionFixtureModel>> = {
  document: { provenance: "synthetic-edge", vm: document1 },
  // The same app, a different identity: two panels, two keys, one manager. This is motivating case #2.
  "document-second-identity": {
    provenance: "synthetic-edge",
    vm: { ...document1, key: "tachyonSectionAppFixture|ws-4f21|t-7ef349", identity: "t-7ef349", revision: 3 },
  },
  // The other cardinality, same code: no identity, one panel per project, re-open reveals.
  dashboard: {
    provenance: "synthetic-edge",
    vm: { ...document1, cardinality: "dashboard", key: "tachyonSectionAppFixture|ws-4f21", identity: "", revision: 2 },
  },
  // After a reveal whose journal could not prove a delta: the panel rebuilt rather than replayed.
  "revealed-resync": { provenance: "synthetic-edge", vm: { ...document1, revision: 9, lastPush: "resync" } },
};

export type SectionAppFixtureRoute = Route<SectionFixtureModel>;
