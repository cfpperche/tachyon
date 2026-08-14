// spec 252 render harness — mounts the REAL Activity <App> with a representative fixture: the header (title +
// stat chips + recent-window search), then a short transcript (user bubble right, agent markdown bubble left,
// a tool chip). Proves the migrated .ds-title (16px) + theme-driven header, with the feed/markdown CSS intact.
import { render } from "preact";
import { App } from "@tachyon/webview-ui/webview/activity/App";
import type { ActivityViewModel } from "@tachyon/webview-ui/activity/activityView";

const vm: ActivityViewModel = {
  runtime: "claude",
  runtimeVersion: "2.1.177",
  tier: "structured",
  summary: {
    messages: 3, toolsRunning: 1, toolsFailed: 0,
    filesChanged: ["PluginsPanel.ts", "App.tsx"], filesReferenced: [],
    tokens: { input: 12500, output: 3400 },
  },
  items: [
    { sequence: 1, kind: "message", role: "user", title: "Migrate the Plugins panel to the shared design system.", timestamp: "2026-06-23T18:00:00Z" },
    { sequence: 2, kind: "message", role: "agent", title: "On it — I'll link `design-system.css` and switch the markup to `.ds-*` classes:\n\n- drop the redefined `:root` tokens\n- keep only panel-specific deltas\n- verify under **dark + light**", timestamp: "2026-06-23T18:00:05Z" },
    { sequence: 3, kind: "tool", title: "Edit", detail: "…/PluginsPanel.ts", result: "applied · +18 −41", timestamp: "2026-06-23T18:00:09Z" },
    { sequence: 4, kind: "message", role: "agent", title: "Done — `tsc ×2`, the engine boundary, and the 1229-test suite are all green.", timestamp: "2026-06-23T18:00:30Z" },
  ],
  hasOlder: false,
};

const dispatch = { openFile() {}, terminal() {}, loadOlder() {} };

const root = document.getElementById("root");
if (root) render(<App vm={vm} dispatch={dispatch} images={{}} query="" setQuery={() => {}} />, root);
