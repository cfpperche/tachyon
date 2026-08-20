const assert = require("node:assert");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("cfpperche.tachyon");
  assert.ok(extension, "Tachyon extension was not loaded (check extensionDevelopmentPath)");
  await extension.activate();
  assert.strictEqual(extension.id, "cfpperche.tachyon");
  assert.strictEqual(extension.isActive, true, "Tachyon extension did not activate");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("tachyon.start"), "Tachyon main command was not registered");
  console.log("extension-host smoke passed: cfpperche.tachyon active, tachyon.start registered");
}

module.exports = { run };
