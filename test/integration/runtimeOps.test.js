const assert = require("node:assert");
const vscode = require("vscode");

describe("Runtime Ops panel (VS Code host smoke)", () => {
  it("registers and focuses the contributed panel without changing the compatibility command id", async function () {
    this.timeout(15000);
    const extension = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(extension, "extension not found in the test host");
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("workbench.view.extension.tachyonRuntimeOps"), "panel container command is missing");
    assert.ok(commands.includes("tachyonRuntimeOpsView.focus"), "webview focus command is missing");

    await vscode.commands.executeCommand("tachyon.showRuntimeUsage");
    await vscode.commands.executeCommand("tachyonRuntimeOpsView.focus");
    await vscode.commands.executeCommand("tachyon.refreshRuntimeOps");
  });
});
