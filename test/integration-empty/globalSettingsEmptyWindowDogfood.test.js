/**
 * t-abde96 — real Extension Host dogfood: empty VS Code window (zero workspace folders).
 *
 * Scenario 2 from the task: with no folder open, `Tachyon: Open Global Settings File`
 * (`tachyon.openGlobalSettings`) must be registered, execute, and create/open the global settings
 * file under the isolated `TACHYON_GLOBAL_SETTINGS_HOME`.
 *
 * Fail-before: if registerGlobalSettingsRecovery runs AFTER the zero-folder early return, the
 * command has no handler here and executeCommand throws / does nothing — this test fails.
 *
 * Isolation: never touches the human home (home is under the vscode-test staging root).
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function globalSettingsFile() {
  const home = process.env.TACHYON_GLOBAL_SETTINGS_HOME;
  assert.ok(home && home.trim(), "TACHYON_GLOBAL_SETTINGS_HOME must isolate the gate from the human home");
  return path.join(home, ".tachyon", "settings.json");
}

describe("t-abde96 — empty window can open/create the global settings file", function () {
  this.timeout(60000);

  it("has zero workspace folders (empty window suite)", () => {
    assert.strictEqual(
      (vscode.workspace.workspaceFolders ?? []).length,
      0,
      "empty-window suite must not attach a workspace folder",
    );
  });

  it("registers tachyon.openGlobalSettings and opens/creates the isolated global file", async function () {
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(ext, "extension not found in the empty-window host");
    await ext.activate();
    assert.strictEqual(ext.isActive, true, "extension must activate with zero folders");

    const file = globalSettingsFile();
    // Start from a clean slate so we prove CREATE as well as open.
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* absent is fine */
    }
    assert.ok(!fs.existsSync(file), "precondition: global settings file must be absent before open");

    // Command must be registered even though activate returned early (no folders).
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("tachyon.openGlobalSettings"),
      "tachyon.openGlobalSettings is not registered with zero workspace folders",
    );

    await vscode.commands.executeCommand("tachyon.openGlobalSettings");
    await sleep(300);

    assert.ok(fs.existsSync(file), `global settings file was not created at ${file}`);
    const text = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.version, 1, "created document must be schema version 1");

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "openGlobalSettings did not show a text editor");
    assert.strictEqual(
      path.resolve(editor.document.uri.fsPath),
      path.resolve(file),
      `active editor is ${editor.document.uri.fsPath}, expected ${file}`,
    );
  });

  it("opens a refused (invalid) global settings file in place for repair", async function () {
    const file = globalSettingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const broken = "{ not valid json — person mid-repair";
    fs.writeFileSync(file, broken, "utf8");

    await vscode.commands.executeCommand("tachyon.openGlobalSettings");
    await sleep(300);

    // Must not rewrite the broken file (recovery surface).
    assert.strictEqual(fs.readFileSync(file, "utf8"), broken, "open must not overwrite a refused document");

    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, "refused document must still open for repair");
    assert.strictEqual(path.resolve(editor.document.uri.fsPath), path.resolve(file));
    assert.ok(editor.document.getText().includes("not valid json"), "editor must show the person's broken text");
  });
});
