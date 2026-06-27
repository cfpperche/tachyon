/**
 * spec 278 — Plugins-view fixtures for the dev preview harness.
 *
 * Provenance: `captured-host-vm` — these VMs were produced by the SAME pure builder the real host uses
 * (`buildPluginsViewModel`), fed a realistic lockfile mirroring Tachyon's own installed set, then captured
 * to `plugins.vms.json`. The harness imports the captured DATA (browser-safe — the builder's dependency
 * chain touches node:path, which can't go in the browser bundle). `webviewPreviewPluginsFixture.test.ts`
 * rebuilds the VMs from the same input and asserts equality, so a builder-shape drift fails CI (the
 * spec-278 fixture-fidelity rule: a fixture must not silently diverge from what the host actually emits).
 */

import type { PluginsViewModel } from "../../../src/plugins/viewModel";
import type { Fixture } from "../routes";
import vms from "./plugins.vms.json";

const captured = vms as unknown as { default: PluginsViewModel; updateAvailable: PluginsViewModel; empty: PluginsViewModel };

export const pluginsFixtures: Record<string, Fixture<PluginsViewModel>> = {
  // every card resolved to "up to date" — the steady state.
  default: { provenance: "captured-host-vm", vm: captured.default },

  // the exact scenario behind this work: visual-qa has an update available (→ 0.2.0).
  "update-available": { provenance: "captured-host-vm", vm: captured.updateAvailable },

  // cold state — no lockfile yet.
  empty: { provenance: "captured-host-vm", vm: captured.empty },
};
