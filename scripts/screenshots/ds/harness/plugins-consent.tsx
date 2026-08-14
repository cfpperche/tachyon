// spec 254 Step 5 render harness — mounts the REAL Plugins <App> with a consent ConsentVM that exercises the
// runtime settings-hooks plus the MCP section (stdio + http servers, env refs), an MCP collision
// (Keep/Replace), and the OQ5 double-confirm ack. Proves the drawer the BLOCKING security gate paints.
import { render } from "preact";
import { App } from "@tachyon/webview-ui/webview/plugins/App";
import type { PluginsViewModel } from "@tachyon/webview-ui/plugins/viewModel";
import type { ConsentVM } from "@tachyon/webview-ui/plugins/consentViewModel";

const vm: PluginsViewModel = { present: ["claude", "codex"], empty: false, installed: [] };

const consent: ConsentVM = {
  op: "install",
  pluginName: "devtools",
  version: "1.0.0",
  title: "Install devtools@1.0.0",
  confirmLabel: "Install",
  provenance: [
    { k: "source", v: "github:acme/devtools@v1.0.0" },
    { k: "resolved commit", v: "a1b2c3d4e5f6" },
  ],
  runtimes: [
    { runtime: "claude", selected: true, present: true },
    { runtime: "codex", selected: true, present: true },
  ],
  settingsHooks: [
    { runtime: "claude", event: "PreToolUse", matchers: ["Bash"] },
    { runtime: "codex", event: "PreToolUse", matchers: ["^Bash$"] },
  ],
  wiredCommands: [
    { runtime: "claude", command: '"/workspace/.tachyon/plugins/devtools/claude/guard.sh"' },
    { runtime: "codex", command: '"/workspace/.tachyon/plugins/devtools/codex/guard.sh"' },
  ],
  writes: [{ file: ".mcp.json", note: "MCP servers merged" }, { file: ".codex/config.toml", note: "MCP servers merged" }],
  mcp: [
    { name: "db", transport: "stdio", detail: "npx -y @scope/db-mcp", env: ["DB_URL"], runtimes: ["claude", "codex"] },
    { name: "search", transport: "http", detail: "https://mcp.example.com/v1", env: ["SEARCH_TOKEN"], runtimes: ["claude"] },
  ],
  mcpCollisions: [{ server: "db", runtime: "claude", key: "claude db" }],
  requiresMcpConfirm: true,
  token: "fp-254-mcp-demo-0001",
};

const dispatch = {
  refresh() {}, checkUpdates() {}, install() {}, update() {}, reinstall() {},
  remove() {}, confirm() {}, cancel() {}, dismissToast() {},
};

const root = document.getElementById("root");
if (root) render(<App vm={vm} consent={consent} dispatch={dispatch} />, root);
