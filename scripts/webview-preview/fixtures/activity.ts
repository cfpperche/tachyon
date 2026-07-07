/**
 * spec 278 — Activity-view fixtures for the dev preview harness.
 *
 * Provenance: `captured-host-vm` — produced by the SAME pipeline the real host uses
 * (`normalizeClaude` → `buildActivityView`) over a realistic, VENDOR-FREE session (text + thinking +
 * Write/Read/Bash tools + usage; NO image/math/mermaid, so the harness never needs the on-demand
 * mermaid/katex bundles), then captured to `activity.vms.json` (browser-safe — the builder chain is
 * node-only). `webviewPreviewActivityFixture.test.ts` rebuilds and asserts equality (drift → CI fail).
 */

import type { ActivityViewModel } from "../../../src/activity/activityView";
import type { Fixture } from "../routes";
import vms from "./activity.vms.json";

const captured = vms as unknown as { default: ActivityViewModel; empty: ActivityViewModel; interrupted: ActivityViewModel };

export const activityFixtures: Record<string, Fixture<ActivityViewModel>> = {
  // a realistic session: a prompt, reasoning, a few tool calls, a green test run.
  default: { provenance: "captured-host-vm", vm: captured.default },

  // the degraded/cold state — no structured activity yet.
  empty: { provenance: "captured-host-vm", vm: captured.empty },

  // edge fixture for the distinct-but-quiet interrupt boundary treatment.
  interrupted: { provenance: "synthetic-edge", vm: captured.interrupted },
};
