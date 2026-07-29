/**
 * t-abde96 — EDH headless dogfood (extensionTestsPath) for global Settings recovery.
 *
 * Two functional scenarios on a REAL Extension Development Host (Xvfb / no human GUI):
 *
 *  1. With workspace: a refused global settings document cannot keep the Agent Pane closed after
 *     a last-known-good that disabled it (fail-toward-enabled).
 *  2. Empty-window half is exercised by a separate launch (no folder); when workspace folders are
 *     zero here, the openGlobalSettings path is still asserted for CREATE + refused open.
 *
 * Isolation: requires TACHYON_GLOBAL_SETTINGS_HOME (set by the outer shell) so the human's
 * ~/.tachyon/settings.json is never touched.
 *
 * Env:
 *   DEV_HOST_RESULT — JSON report path
 *   TACHYON_GLOBAL_SETTINGS_HOME — disposable home for settings.json
 *   DEV_HOST_SHA — recorded SHA
 */
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeResult(payload) {
  const out = process.env.DEV_HOST_RESULT || process.env.EDH_PALLIATIVE_RESULT;
  if (!out) {
    console.log("[settings-recovery] result:", JSON.stringify(payload, null, 2));
    return;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function check(asserts, ok, id, detail) {
  asserts.push({ id, ok: !!ok, detail: detail ?? "" });
  if (!ok) console.error(`[settings-recovery] FAIL ${id}: ${detail ?? ""}`);
  else console.log(`[settings-recovery] ok   ${id}${detail ? ` — ${detail}` : ""}`);
}

function globalSettingsFile() {
  const home = process.env.TACHYON_GLOBAL_SETTINGS_HOME;
  if (!home || !home.trim()) throw new Error("TACHYON_GLOBAL_SETTINGS_HOME is required (isolation)");
  return path.join(home, ".tachyon", "settings.json");
}

function writeGlobalSettings(text) {
  const file = globalSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  const now = Date.now() / 1000 + 1;
  fs.utimesSync(file, now, now);
  return file;
}

function workspaceHash(p) {
  return crypto.createHash("sha256").update(p).digest("hex").slice(0, 8);
}

function describeTabs() {
  const rows = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      rows.push({
        label: tab.label,
        inputCtor: input?.constructor?.name ?? typeof input,
        viewType: input && typeof input === "object" && "viewType" in input
          ? String(/** @type {{ viewType: unknown }} */ (input).viewType)
          : null,
      });
    }
  }
  return rows;
}

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

async function waitFor(pred, timeoutMs, stepMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function closeAgentPaneTabs(agent) {
  for (const tab of agentPaneTabs(agent)) {
    try {
      await vscode.window.tabGroups.close(tab);
    } catch {
      /* best effort */
    }
  }
  await sleep(150);
}

exports.run = async function run() {
  const asserts = [];
  const startedAt = new Date().toISOString();
  const sha = process.env.DEV_HOST_SHA || process.env.EDH_PALLIATIVE_SHA || "unknown";
  let mode = "unknown";

  try {
    const home = process.env.TACHYON_GLOBAL_SETTINGS_HOME;
    check(asserts, !!(home && home.trim()), "isolation.home", home || "missing TACHYON_GLOBAL_SETTINGS_HOME");
    if (!home) throw new Error("refuse to run without settings isolation");

    const folders = vscode.workspace.workspaceFolders ?? [];
    mode = folders.length === 0 ? "empty-window" : "with-workspace";
    console.log(`[settings-recovery] mode=${mode} folders=${folders.length} home=${home}`);

    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    check(asserts, !!ext, "extension.present", ext ? ext.id : "missing");
    if (!ext) throw new Error("extension not found");
    await ext.activate();
    check(asserts, ext.isActive, "extension.active", "activate() completed");

    // ── Scenario 2 / empty path: openGlobalSettings registered + create/open ──
    {
      const commands = await vscode.commands.getCommands(true);
      check(
        asserts,
        commands.includes("tachyon.openGlobalSettings"),
        "command.registered",
        mode === "empty-window"
          ? "registered with zero workspace folders"
          : "registered with workspace",
      );

      const file = globalSettingsFile();
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* absent ok */
      }
      check(asserts, !fs.existsSync(file), "file.absent.before", file);

      await vscode.commands.executeCommand("tachyon.openGlobalSettings");
      await sleep(400);

      check(asserts, fs.existsSync(file), "file.created", file);
      if (fs.existsSync(file)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
          check(asserts, parsed.version === 1, "file.schema", `version=${parsed.version}`);
        } catch (err) {
          check(asserts, false, "file.schema", err instanceof Error ? err.message : String(err));
        }
      }

      const editor = vscode.window.activeTextEditor;
      check(
        asserts,
        !!editor && path.resolve(editor.document.uri.fsPath) === path.resolve(file),
        "editor.shows.file",
        editor ? editor.document.uri.fsPath : "no active editor",
      );

      // Refused document opens in place (recovery surface) — do not overwrite.
      const broken = "{ not valid json — mid repair /*";
      writeGlobalSettings(broken);
      await vscode.commands.executeCommand("tachyon.openGlobalSettings");
      await sleep(300);
      check(
        asserts,
        fs.readFileSync(file, "utf8") === broken,
        "refused.not.overwritten",
        "open must leave broken document for repair",
      );
      const repairEditor = vscode.window.activeTextEditor;
      check(
        asserts,
        !!repairEditor && repairEditor.document.getText().includes("not valid json"),
        "refused.opens.for.repair",
        repairEditor ? "shown" : "no editor",
      );
    }

    // ── Scenario 1: only when a workspace is open (Agent Pane needs roster + engine) ──
    if (folders.length > 0) {
      const folder = folders[0].uri.fsPath;
      const wsHash = workspaceHash(folder);
      const agent = "echoer";

      // Restore a valid document so the pane path can baseline.
      writeGlobalSettings(JSON.stringify({ version: 1 }, null, 2));
      await vscode.commands.executeCommand("tachyon.openGlobalSettings");
      await sleep(200);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");

      // Wait for roster (engine + declared terminal).
      const listed = await waitFor(async () => {
        try {
          const entries = (await vscode.commands.executeCommand("tachyon._agents", wsHash)) ?? [];
          return Array.isArray(entries) && entries.some((e) => e && e.name === agent);
        } catch {
          return false;
        }
      }, 90000);
      check(asserts, listed, "roster.echoer", listed ? `wsHash=${wsHash}` : "echoer never appeared");

      if (listed) {
        // Baseline: defaults → pane must open (proves open path itself).
        await closeAgentPaneTabs(agent);
        await vscode.commands.executeCommand("tachyon.openAgentPaneItem", agent, wsHash);
        const baseline = await waitFor(() => agentPaneTabs(agent).length > 0, 20000);
        check(
          asserts,
          baseline,
          "pane.baseline.open",
          baseline ? "ok" : `tabs=${JSON.stringify(describeTabs())}`,
        );
        await closeAgentPaneTabs(agent);

        // LKG: pane OFF under a valid document → open must refuse.
        writeGlobalSettings(JSON.stringify({ version: 1, agentPane: { enabled: false } }, null, 2));
        await vscode.commands.executeCommand("tachyon.openGlobalSettings");
        await sleep(250);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("tachyon.openAgentPaneItem", agent, wsHash);
        await sleep(600);
        const closedWhenDisabled = agentPaneTabs(agent).length === 0;
        check(
          asserts,
          closedWhenDisabled,
          "pane.disabled.refuses",
          closedWhenDisabled ? "stayed closed" : `tabs=${JSON.stringify(describeTabs())}`,
        );

        // Break the document after LKG-disabled: fail-toward must re-enable the surface.
        writeGlobalSettings("{ not valid json — mid repair /*");
        await sleep(150);
        await vscode.commands.executeCommand("tachyon.openGlobalSettings");
        await sleep(250);
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await closeAgentPaneTabs(agent);
        await vscode.commands.executeCommand("tachyon.openAgentPaneItem", agent, wsHash);
        const openedUnderRefusal = await waitFor(() => agentPaneTabs(agent).length > 0, 15000);
        check(
          asserts,
          openedUnderRefusal,
          "pane.refused.fail.toward.enabled",
          openedUnderRefusal
            ? "opened under refused document"
            : `tabs=${JSON.stringify(describeTabs())} file=${globalSettingsFile()}`,
        );
        await closeAgentPaneTabs(agent);
        writeGlobalSettings(JSON.stringify({ version: 1 }, null, 2));
      }
    } else {
      check(asserts, true, "pane.skipped.empty.window", "Agent Pane scenario requires a workspace; empty-window launch covers command registration only");
    }

    const failed = asserts.filter((a) => !a.ok);
    writeResult({
      ok: failed.length === 0,
      scenario: "t-abde96-settings-recovery",
      mode,
      sha,
      startedAt,
      finishedAt: new Date().toISOString(),
      asserts,
      failed: failed.map((a) => a.id),
    });
    if (failed.length > 0) {
      throw new Error(`settings-recovery asserts failed: ${failed.map((a) => a.id).join(", ")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[settings-recovery] fatal:", message);
    writeResult({
      ok: false,
      scenario: "t-abde96-settings-recovery",
      mode,
      sha,
      startedAt,
      finishedAt: new Date().toISOString(),
      asserts,
      error: message,
    });
    throw error;
  }
};
