const assert = require("node:assert");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * t-1e5ab8 — this suite used to assert the spec 367 bottom-panel container
 * (`workbench.view.extension.tachyonRuntimeOps`) and its `tachyonRuntimeOpsView.focus` command. Both
 * were retired with the panel itself (t-ed3067, 2026-07-20): Runtime Ops lived only as a Control
 * section then, and `package.json` contributes no such container or view. The failure was assertion
 * rot, not a registration regression — so this pins what the migration actually promised to keep.
 *
 * t-9e3978 — and it rotted a SECOND time, one migration later. SDD 485 D3 took Runtime Ops out of
 * Control and gave it its own editor tab (`RuntimeOpsPanelManager.open()`, titled "Runtime Ops"),
 * while this test still asserted the tab label contained "Control". Measured 2026-08-18 on the
 * editor-host gate: the command DID open the surface and the host reported
 * `tabs: , flaky, Runtime Ops, prompter` — the assertion named the pre-D3 home, so the product was
 * right and the test was wrong. The destination is what changed; the command ids did not, which is
 * the whole point of the compatibility ids below.
 */
describe("Runtime Ops (VS Code host smoke)", () => {
  it("keeps the compatibility command ids and opens the Runtime Ops tab", async function () {
    this.timeout(20000);
    const extension = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(extension, "extension not found in the test host");
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    // The ids spec 367 promised not to change, plus the route the compatibility id now resolves to.
    for (const id of ["tachyon.showRuntimeUsage", "tachyon.refreshRuntimeOps", "tachyon.openControlRuntime"]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
    // The retired panel surface stays retired: a contribution creeping back would mean two homes for
    // Runtime Ops, which is exactly what the Control consolidation removed.
    for (const id of ["workbench.view.extension.tachyonRuntimeOps", "tachyonRuntimeOpsView.focus"]) {
      assert.ok(!commands.includes(id), `retired panel command is registered again: ${id}`);
    }

    // Close Runtime Ops first, so what follows proves THIS command opened it. Focus is not asserted:
    // another editor tab can win it back in the headless host, and being open is the observable.
    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label.includes("Runtime Ops"));
    if (open.length > 0) await vscode.window.tabGroups.close(open, false);
    await sleep(300);

    await vscode.commands.executeCommand("tachyon.showRuntimeUsage");
    await sleep(1000);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    assert.ok(
      tabs.some((l) => l.includes("Runtime Ops")),
      `Runtime Ops not opened by the compatibility command; tabs: ${tabs.join(", ")}`,
    );

    // The manual refresh still runs against the live fleet view (no panel webview to push to).
    await vscode.commands.executeCommand("tachyon.refreshRuntimeOps");
  });
});
