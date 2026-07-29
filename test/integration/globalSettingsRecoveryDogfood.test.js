/**
 * t-abde96 — real Extension Host dogfood for global Settings recovery (workspace present).
 *
 * Scenario 1 from the task: with the global settings document INVALID / refused, the Agent Pane
 * must still open (fail-toward-enabled). A last-known-good that had the pane disabled must not be
 * able to keep it disabled once the on-disk document is refused — that is the recovery surface.
 *
 * Isolation: `.vscode-test.mjs` sets `TACHYON_GLOBAL_SETTINGS_HOME` under the staging root so this
 * never touches a human's real `~/.tachyon/settings.json`.
 *
 * Fail-before structure (observable in a real host, not a mock):
 *  1) under a valid document with agentPane.enabled=false → open is refused (no webview tab)
 *  2) after that LKG, with the document refused → open succeeds (webview tab appears)
 * If fail-toward is removed, step 2 keeps the pane closed and this suite goes red.
 */
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workspaceHash(p) {
  return crypto.createHash("sha256").update(p).digest("hex").slice(0, 8);
}

function globalSettingsFile() {
  const home = process.env.TACHYON_GLOBAL_SETTINGS_HOME;
  assert.ok(home && home.trim(), "TACHYON_GLOBAL_SETTINGS_HOME must isolate the gate from the human home");
  return path.join(home, ".tachyon", "settings.json");
}

function writeGlobalSettings(text) {
  const file = globalSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  // Ensure mtime advances so GlobalSettingsStore.stampNow() reloads.
  const now = Date.now() / 1000 + 1;
  fs.utimesSync(file, now, now);
}

function describeTabs() {
  const rows = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      let viewType = null;
      if (input && typeof input === "object" && "viewType" in input) {
        viewType = String(/** @type {{ viewType: unknown }} */ (input).viewType);
      }
      rows.push({
        label: tab.label,
        inputCtor: input?.constructor?.name ?? typeof input,
        viewType,
      });
    }
  }
  return rows;
}

/** Prefer exact viewType; fall back to webview tab whose label is the agent (createWebviewPanel title). */
function agentPaneTabs(agent) {
  const found = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!input || typeof input !== "object") continue;
      const viewType = "viewType" in input ? String(/** @type {{ viewType: unknown }} */ (input).viewType) : "";
      const isAgentPaneView = viewType === "tachyonAgentPane" || viewType.endsWith("tachyonAgentPane");
      const isWebviewForAgent = input.constructor?.name === "TabInputWebview" && tab.label === agent;
      if (isAgentPaneView || isWebviewForAgent) found.push(tab);
    }
  }
  return found;
}

async function closeAgentPaneTabs(agent) {
  for (const tab of agentPaneTabs(agent)) {
    await vscode.window.tabGroups.close(tab);
  }
  await sleep(100);
}

async function waitFor(pred, timeoutMs = 15000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function openAgentPane(agent, wsHash) {
  await vscode.commands.executeCommand("tachyon.openAgentPaneItem", agent, wsHash);
}

describe("t-abde96 — invalid global settings still allow Agent Pane (fail-toward-enabled)", function () {
  this.timeout(120000);

  const agent = "echoer";
  let wsHash;

  before(async function () {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "single-root suite must open a workspace");
    wsHash = workspaceHash(folder.uri.fsPath);
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(ext, "extension not found");
    await ext.activate();
    assert.strictEqual(ext.isActive, true);

    // Wait for the declared terminal in the live roster.
    const listed = await waitFor(async () => {
      const entries = (await vscode.commands.executeCommand("tachyon._agents", wsHash)) ?? [];
      return entries.some((e) => e && e.name === agent);
    }, 60000);
    assert.ok(listed, "precondition: fixture terminal 'echoer' never appeared in the live roster");

    // Isolation home must be the staged one (never the human home).
    assert.ok(
      process.env.TACHYON_GLOBAL_SETTINGS_HOME.includes("tachyon-vscode-test"),
      `TACHYON_GLOBAL_SETTINGS_HOME is not under the vscode-test staging root: ${process.env.TACHYON_GLOBAL_SETTINGS_HOME}`,
    );

    // Precondition: with defaults (enabled), the open path itself works — proves projection + webview,
    // not merely agents.list. Without this, a "pane did not open" under refusal is vacuous.
    writeGlobalSettings(JSON.stringify({ version: 1 }, null, 2));
    await vscode.commands.executeCommand("tachyon.openGlobalSettings");
    await sleep(200);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await sleep(100);
    await openAgentPane(agent, wsHash);
    const baseline = await waitFor(() => agentPaneTabs(agent).length > 0, 20000);
    assert.ok(
      baseline,
      "precondition failed: Agent Pane never opens under valid default settings — " +
        `cannot judge fail-toward. tabs=${JSON.stringify(describeTabs())}`,
    );
    await closeAgentPaneTabs(agent);
  });

  it("refused settings cannot keep the Agent Pane disabled after a last-known-good that disabled it", async function () {
    const file = globalSettingsFile();

    // 1) Establish LKG with the pane deliberately OFF.
    writeGlobalSettings(JSON.stringify({ version: 1, agentPane: { enabled: false } }, null, 2));
    await vscode.commands.executeCommand("tachyon.openGlobalSettings");
    await sleep(200);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await sleep(100);

    // 2) With a VALID disabled document, open must refuse — proves the gate is live (not always-on).
    await openAgentPane(agent, wsHash);
    await sleep(500);
    assert.strictEqual(
      agentPaneTabs(agent).length,
      0,
      "precondition: with agentPane.enabled=false the pane must stay closed " +
        `(gate dead or detection wrong). tabs=${JSON.stringify(describeTabs())}`,
    );

    // 3) Break the document. Fail-toward-enabled must force agentPaneEnabled=true on the next read.
    writeGlobalSettings("{ not valid json — mid repair /*");
    await sleep(150);
    // Force a store re-read of the refusal before open (also the human recovery path).
    await vscode.commands.executeCommand("tachyon.openGlobalSettings");
    await sleep(200);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await sleep(100);
    assert.strictEqual(agentPaneTabs(agent).length, 0, "precondition: no agent pane open yet");

    // 4) Open the pane. If fail-toward-enabled is missing, openAgentPane returns early and no panel appears.
    await openAgentPane(agent, wsHash);
    const opened = await waitFor(() => agentPaneTabs(agent).length > 0, 15000);
    assert.ok(
      opened,
      "Agent Pane did not open under a refused global settings document — fail-toward-enabled regressed " +
        `(settings file: ${file}; tabs=${JSON.stringify(describeTabs())})`,
    );

    // Cleanup: restore a valid empty document so later scenarios do not inherit refusal.
    writeGlobalSettings(JSON.stringify({ version: 1 }, null, 2));
    await closeAgentPaneTabs(agent);
  });
});
