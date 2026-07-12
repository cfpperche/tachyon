/**
 * spec 278 — Activity-view fixtures for the dev preview harness.
 *
 * Provenance: `captured-host-vm` — produced by the SAME pipeline the real host uses
 * (`normalizeClaude` → `buildActivityView`) over a realistic, VENDOR-FREE session (text + thinking +
 * Write/Read/Bash tools + usage; NO image/math/mermaid, so the harness never needs the on-demand
 * mermaid/katex bundles), then captured to `activity.vms.json` (browser-safe — the builder chain is
 * node-only). `webviewPreviewActivityFixture.test.ts` rebuilds and asserts equality (drift → CI fail).
 *
 * spec 374 — `mermaid-nav` is a separate synthetic-edge fixture with fenced ```mermaid blocks so the
 * preview harness can dogfood read-only zoom/pan chrome. It is NOT part of the vendor-free fidelity
 * snapshot (`activity.vms.json`).
 */

import type { ActivityViewModel } from "../../../src/activity/activityView";
import type { Fixture } from "../routes";
import vms from "./activity.vms.json";
import mermaidNavVm from "./activity-mermaid-nav.vm.json";
import grokFeedVm from "./activity-grok-feed.vm.json";

const captured = vms as unknown as { default: ActivityViewModel; empty: ActivityViewModel; interrupted: ActivityViewModel };

export const activityFixtures: Record<string, Fixture<ActivityViewModel>> = {
  // a realistic session: a prompt, reasoning, a few tool calls, a green test run.
  default: { provenance: "captured-host-vm", vm: captured.default },

  // the degraded/cold state — no structured activity yet.
  empty: { provenance: "captured-host-vm", vm: captured.empty },

  // edge fixture for the distinct-but-quiet interrupt boundary treatment.
  interrupted: { provenance: "synthetic-edge", vm: captured.interrupted },

  // large + small mermaid diagrams for read-only nav chrome (spec 374).
  "mermaid-nav": { provenance: "synthetic-edge", vm: mermaidNavVm as unknown as ActivityViewModel },

  // t-9874be shortlist dogfood — Grok chat_history-shaped feed (user/thinking/tools/files).
  "grok-feed": { provenance: "synthetic-edge", vm: grokFeedVm as unknown as ActivityViewModel },
};
