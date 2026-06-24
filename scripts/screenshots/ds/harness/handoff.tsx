// spec 252 render harness — mounts the REAL Handoff <App> with a representative fixture. Exercises the header
// (.ds-title + staleness .ds-badge + .ds-btn actions), the markdown body (.md delta), the meta subline, and the
// pending-note lane, so the screenshot proves the title is 16px and the badge/buttons match the other panels.
import { render } from "preact";
import { App } from "../../../../src/webview/handoff/App";
import type { HandoffViewModel } from "../../../../src/webview/handoff/handoffViewModel";

const vm: HandoffViewModel = {
  folder: "tachyon",
  exists: true,
  staleness: "needs_distill",
  pendingCount: 2,
  updatedAt: "2026-06-23T18:00:00Z",
  updatedBy: "human",
  revision: "a1b2c3d4e5",
  body: [
    "## Current State",
    "The plugin system shipped in **0.36.0**. Webview design-system migration is in flight (spec 252).",
    "",
    "## Active Work",
    "- Migrating each panel onto the shared `.ds-*` layer",
    "- [x] Plugins",
    "- [ ] Handoff",
    "",
    "## Next Actions",
    "1. Server Inspector",
    "2. Agent Studio",
    "",
    "> Keep `tsc ×2` + engine-boundary + the suite green throughout.",
  ].join("\n"),
  notes: [
    { ts: "2026-06-23T17:30:00Z", agent: "claude", kind: "decision", summary: "Title size unified to 16px (D1).", evidence: ["spec.md#D1"] },
    { ts: "2026-06-23T17:45:00Z", agent: "codex", kind: "next", summary: "Verify light theme exposes no hardcoded dark hex.", evidence: [] },
  ],
};

const dispatch = { refresh() {}, openFile() {} };

const root = document.getElementById("root");
if (root) render(<App vm={vm} dispatch={dispatch} />, root);
