// spec 252 render harness — mounts the REAL Plugins <App> with a representative fixture (no vscode, no host).
// Covers the header/title, the install addbar, the Installed/Marketplace tabs, and cards spanning the badge
// tones (ok / warn / err) + runtime pills, so the screenshot exercises every shared .ds-* component.
import { render } from "preact";
import { App } from "@tachyon/webview-ui/webview/plugins/App";
import type { PluginsViewModel } from "@tachyon/webview-ui/plugins/viewModel";

const vm: PluginsViewModel = {
  present: ["claude", "codex"],
  empty: false,
  installed: [
    {
      name: "tachyon-reviewer", version: "1.4.0", sourceSpec: "github:acme/tachyon-reviewer@v1.4.0",
      shortCommit: "a1b2c3d", localInstall: false,
      runtimes: [{ runtime: "claude", present: true }, { runtime: "codex", present: true }],
      status: { kind: "up-to-date" }, actions: ["update", "remove"],
    },
    {
      name: "spec-linter", version: "0.9.2", sourceSpec: "github:acme/spec-linter@main",
      shortCommit: "9f8e7d6", localInstall: false,
      runtimes: [{ runtime: "claude", present: true }, { runtime: "codex", present: false }],
      status: { kind: "update-available", latestVersion: "1.0.0" }, actions: ["update", "remove"],
    },
    {
      name: "local-scratch", version: "0.0.1", localInstall: true,
      runtimes: [{ runtime: "claude", present: true }],
      status: { kind: "drift", detail: "edited locally" }, actions: ["reinstall", "remove"],
    },
  ],
};

const dispatch = {
  refresh() {}, checkUpdates() {}, install() {}, update() {}, reinstall() {},
  remove() {}, confirm() {}, cancel() {}, dismissToast() {},
};

const root = document.getElementById("root");
if (root) render(<App vm={vm} dispatch={dispatch} />, root);
