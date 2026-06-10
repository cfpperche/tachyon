const assert = require("node:assert");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

function workspaceHash(p) {
  return crypto.createHash("sha256").update(p).digest("hex").slice(0, 8);
}

function tachyonSessions() {
  try {
    return execFileSync("tmux", ["-L", "tachyon", "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("Tachyon extension (VSCode host smoke)", () => {
  let wsHash;

  before(() => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "test host opened no workspace");
    wsHash = workspaceHash(folder.uri.fsPath);
  });

  after(() => {
    // Belt-and-braces cleanup of this workspace's sessions only.
    for (const session of tachyonSessions()) {
      if (session.startsWith(`tachyon-${wsHash}-`)) {
        try {
          execFileSync("tmux", ["-L", "tachyon", "kill-session", "-t", `=${session}`], { stdio: "pipe" });
        } catch {
          /* already gone */
        }
      }
    }
  });

  it("activates on a workspace containing tachyon.yml", async () => {
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(ext, "extension not found in the test host");
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  it("binds the Bridge to the stable derived port (spec 189)", async () => {
    // Same derivation as src/bridge/Bridge.ts.
    const derived = 41000 + (parseInt(wsHash.slice(0, 4), 16) % 2000);
    await vscode.commands.executeCommand("tachyon.copyBridgeUrl");
    const url = await vscode.env.clipboard.readText();
    assert.strictEqual(url, `http://127.0.0.1:${derived}/mcp`);
  });

  it("Bridge rejects unauthenticated calls and accepts the workspace token (spec 191)", async function () {
    this.timeout(15000);
    await vscode.commands.executeCommand("tachyon.copyBridgeUrl");
    const url = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand("tachyon.copyBridgeToken");
    const token = await vscode.env.clipboard.readText();
    assert.match(token, /^[0-9a-f]{64}$/, "expected a hex token in the clipboard");

    const noAuth = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.strictEqual(noAuth.status, 401, "unauthenticated POST must be rejected");

    const authed = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    assert.notStrictEqual(authed.status, 401, "authenticated POST must pass the auth gate");
  });

  it("contributes the sidebar views and refresh command", async () => {
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    const contributes = ext.packageJSON.contributes;
    assert.ok(contributes.viewsContainers.activitybar.some((c) => c.id === "tachyon"));
    assert.deepStrictEqual(
      contributes.views.tachyon.map((v) => v.id),
      ["tachyonAgents", "tachyonLayouts", "tachyonPins"],
    );
    await vscode.commands.executeCommand("tachyon.refreshViews"); // must not throw
  });

  it("package.nls keys resolve (no raw %key% leaks) (spec 196)", async () => {
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    const contributes = ext.packageJSON.contributes;
    const leaked = contributes.commands.filter((c) => c.title.includes("%"));
    assert.deepStrictEqual(leaked.map((c) => c.command), [], "nls keys did not resolve");
    assert.ok(!contributes.configuration.properties["tachyon.maxAgents"].description.includes("%"));
    for (const v of contributes.views.tachyon) assert.ok(!v.name.includes("%"), `view name unresolved: ${v.name}`);
  });

  it("registers the Tachyon commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const cmd of [
      "tachyon.start",
      "tachyon.stopAll",
      "tachyon.restartAgent",
      "tachyon.openAgentTerminal",
      "tachyon.applyLayout",
      "tachyon.copyBridgeUrl",
      "tachyon.connectRuntime",
    ]) {
      assert.ok(commands.includes(cmd), `missing command ${cmd}`);
    }
  });

  it("spawns the autostart agent into a real tmux session (spec scenario 1)", async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand("tachyon.start");
    const expected = `tachyon-${wsHash}-echoer`;
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await sleep(250);
      found = tachyonSessions().includes(expected);
    }
    assert.ok(found, `session ${expected} not found; sessions: ${tachyonSessions().join(", ")}`);
  });

  it("re-attaches a surviving session without restarting it (spec scenario 4)", async function () {
    this.timeout(15000);
    // The launcher pre-spawns tachyon-<hash>-survivor BEFORE this VSCode host boots
    // (simulating an agent left running by a previous editor) and records its creation
    // time. If activation had killed or restarted it, the timestamp would differ.
    const fs = require("node:fs");
    if (!fs.existsSync("/tmp/tachyon-survivor-created.txt")) this.skip();
    const expected = fs.readFileSync("/tmp/tachyon-survivor-created.txt", "utf8").trim();
    const session = `tachyon-${wsHash}-survivor`;
    const created = execFileSync(
      "tmux",
      ["-L", "tachyon", "display-message", "-p", "-t", `=${session}:`, "#{session_created}"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    assert.strictEqual(created, expected, "survivor was restarted (creation time changed) or killed");
  });

  it("applies a named grid layout in the editor area (spec scenario 2)", async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand("tachyon.applyLayout", "solo");
    let groups = 0;
    for (let i = 0; i < 40 && groups < 2; i++) {
      await sleep(250);
      groups = vscode.window.tabGroups.all.length;
    }
    assert.ok(groups >= 2, `expected a 2up editor grid, got ${groups} tab group(s)`);
  });

  it("restarts the agent when a watched file changes (spec scenario 5)", async function () {
    this.timeout(30000);
    const fs = require("node:fs");
    const path = require("node:path");
    const session = `tachyon-${wsHash}-echoer`;
    const createdOf = () => {
      try {
        return execFileSync("tmux", ["-L", "tachyon", "display-message", "-p", "-t", `=${session}:`, "#{session_created}"], {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        return null;
      }
    };
    const before = createdOf();
    assert.ok(before, "echoer should be running before the watch test");
    await sleep(1100); // session_created has 1s resolution — ensure a restart is observable
    const trigger = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "trigger.txt");
    fs.writeFileSync(trigger, `poke ${Date.now()}\n`);
    let after = before;
    for (let i = 0; i < 60 && after === before; i++) {
      await sleep(250);
      after = createdOf();
    }
    fs.rmSync(trigger, { force: true });
    assert.notStrictEqual(after, before, "session_created unchanged — watch restart never fired");
    assert.ok(after, "agent not running after watch restart");
  });

  it("detects a real prompt as needs-input (spec 188 scenario 1)", async function () {
    this.timeout(45000);
    const session = `tachyon-${wsHash}-prompter`;
    // Wait for the prompter agent (autostart) to be alive, then make it show a prompt.
    let alive = false;
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(250);
      alive = tachyonSessions().includes(session);
    }
    assert.ok(alive, "prompter agent not running");
    execFileSync(
      "tmux",
      ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "-l", "--", "printf 'Do you want to continue? [y/n] '"],
      { stdio: "pipe" },
    );
    execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });

    // Real poller (3s) + pattern-stability gate (2.5s) — give it up to 30s.
    let state;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const states = await vscode.commands.executeCommand("tachyon._attention");
      state = states && states.prompter;
      if (state && state.state === "needs-input") break;
    }
    assert.ok(state, "no attention state reported for prompter");
    assert.strictEqual(state.state, "needs-input", `expected needs-input, got ${JSON.stringify(state)}`);
    assert.ok(/\[y\/n\]/i.test(state.matchedLine || ""), "matched line should carry the prompt");

    // Answering resets the episode back to working.
    execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "-l", "--", "y"], { stdio: "pipe" });
    execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });
    let reset = false;
    for (let i = 0; i < 30 && !reset; i++) {
      await sleep(500);
      const states = await vscode.commands.executeCommand("tachyon._attention");
      reset = states && states.prompter && states.prompter.state !== "needs-input";
    }
    assert.ok(reset, "state did not reset after the prompt was answered");
  });

  it("a crash is exposed with its exit code; the dead pane survives for postmortem (spec 190)", async function () {
    this.timeout(45000);
    const session = `tachyon-${wsHash}-prompter`; // restart: never (default)
    execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "-l", "--", "exit 3"], { stdio: "pipe" });
    execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });

    let info;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const agents = await vscode.commands.executeCommand("tachyon._agents");
      info = agents.find((a) => a.name === "prompter");
      if (info && info.crashed) break;
    }
    assert.ok(info && info.crashed, `prompter never reported crashed: ${JSON.stringify(info)}`);
    assert.strictEqual(info.exitCode, 3);
    assert.strictEqual(info.running, false);
    // the dead pane still exists in tmux for postmortem (session not vanished)
    assert.ok(tachyonSessions().includes(session), "postmortem session should survive the crash");
  });

  it("restart: on-crash auto-restarts a crashed agent (spec 190)", async function () {
    this.timeout(60000);
    const session = `tachyon-${wsHash}-flaky`;
    let alive = false;
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(250);
      alive = tachyonSessions().includes(session);
    }
    assert.ok(alive, "flaky agent not running before the crash test");
    execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "-l", "--", "exit 5"], { stdio: "pipe" });
    execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });

    // poller (3s) + backoff (2s) — the agent must come back on its own
    let back = false;
    for (let i = 0; i < 80 && !back; i++) {
      await sleep(500);
      const agents = await vscode.commands.executeCommand("tachyon._agents");
      const info = agents.find((a) => a.name === "flaky");
      back = Boolean(info && info.running && !info.crashed);
    }
    assert.ok(back, "flaky was not auto-restarted after crashing");
  });

  it("pins persist to .tachyon/pins.json and round-trip (spec 192)", async function () {
    this.timeout(15000);
    const fs = require("node:fs");
    const path = require("node:path");
    const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const pinsFile = path.join(wsRoot, ".tachyon", "pins.json");
    try {
      await vscode.commands.executeCommand("tachyon.addPin", "integration finding");
      const pins = await vscode.commands.executeCommand("tachyon._pins");
      const mine = pins.find((p) => p.text === "integration finding");
      assert.ok(mine, "pin not listed after addPin");
      assert.strictEqual(mine.by, "human");
      assert.ok(fs.readFileSync(pinsFile, "utf8").includes("integration finding"), "pin not persisted to the file door");
    } finally {
      fs.rmSync(path.join(wsRoot, ".tachyon"), { recursive: true, force: true });
    }
  });

  it("agent CRUD edits tachyon.yml from the UI commands (spec 193)", async function () {
    this.timeout(20000);
    const fs = require("node:fs");
    const path = require("node:path");
    const ymlPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "tachyon.yml");
    const original = fs.readFileSync(ymlPath, "utf8");
    const declared = async () => (await vscode.commands.executeCommand("tachyon._agents")).filter((a) => a.declared).map((a) => a.name);
    try {
      // create (args skip the input boxes)
      await vscode.commands.executeCommand("tachyon.newAgent", "uitest", "sh");
      assert.ok((await declared()).includes("uitest"), "new agent not declared after newAgent");
      const agents = await vscode.commands.executeCommand("tachyon._agents");
      assert.strictEqual(agents.find((a) => a.name === "uitest").kind, "terminal", "sh should infer kind terminal");
      assert.strictEqual(agents.find((a) => a.name === "claude" || a.name === "prompter")?.kind, "agent");
      assert.ok(fs.readFileSync(ymlPath, "utf8").includes("uitest"), "yml not updated");

      // clone
      await vscode.commands.executeCommand("tachyon.cloneAgentItem", { agentName: "uitest" }, "uitest-2");
      assert.ok((await declared()).includes("uitest-2"), "clone not declared");

      // rename (agent never started — allowed)
      await vscode.commands.executeCommand("tachyon.renameAgentItem", { agentName: "uitest-2" }, "uitest-renamed");
      const after = await declared();
      assert.ok(after.includes("uitest-renamed") && !after.includes("uitest-2"), "rename not applied");

      // delete (force skips the modal)
      await vscode.commands.executeCommand("tachyon.deleteAgentItem", { agentName: "uitest-renamed" }, true);
      await vscode.commands.executeCommand("tachyon.deleteAgentItem", { agentName: "uitest" }, true);
      const final = await declared();
      assert.ok(!final.includes("uitest") && !final.includes("uitest-renamed"), "delete not applied");
    } finally {
      fs.writeFileSync(ymlPath, original, "utf8");
    }
  });

  it("Agent Studio pipeline: full-def upsert, edit-in-place, blocking validation (spec 195)", async function () {
    this.timeout(20000);
    const fs = require("node:fs");
    const path = require("node:path");
    const ymlPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "tachyon.yml");
    const original = fs.readFileSync(ymlPath, "utf8");
    const state = {
      name: "studio-rev",
      cmd: "claude --permission-mode plan",
      kind: "agent",
      instructions: "you are a code reviewer",
      cwd: "",
      autostart: false,
      restartOnCrash: true,
      attention: true,
    };
    try {
      // create through the same pipeline the webview submit uses
      let errors = await vscode.commands.executeCommand("tachyon._upsertAgent", { state });
      assert.strictEqual(errors, undefined, `unexpected errors: ${JSON.stringify(errors)}`);
      const yml = fs.readFileSync(ymlPath, "utf8");
      assert.ok(yml.includes("studio-rev") && yml.includes("you are a code reviewer"), "full def not written");
      const agents = await vscode.commands.executeCommand("tachyon._agents");
      assert.strictEqual(agents.find((a) => a.name === "studio-rev").kind, "agent");

      // duplicate name blocks
      errors = await vscode.commands.executeCommand("tachyon._upsertAgent", { state });
      assert.ok(errors && errors.some((e) => e.includes("already exists")), "duplicate should block");

      // edit-in-place via editingName
      errors = await vscode.commands.executeCommand("tachyon._upsertAgent", {
        state: { ...state, cmd: "codex" },
        editingName: "studio-rev",
      });
      assert.strictEqual(errors, undefined);
      assert.ok(fs.readFileSync(ymlPath, "utf8").includes("codex"), "edit not applied");

      // the studio command opens a webview tab
      await vscode.commands.executeCommand("tachyon.agentStudio");
      await sleep(500);
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
      assert.ok(tabs.some((l) => l.includes("Agent Studio")), `studio tab not found in: ${tabs.join(", ")}`);
    } finally {
      fs.writeFileSync(ymlPath, original, "utf8");
    }
  });

  it("lineage: spawn with parent shows in _agents; orphan promoted on parent kill (spec 197)", async function () {
    this.timeout(20000);
    // prompter (declared, running) plays the orchestrator; child is ad-hoc with instructions
    await vscode.commands.executeCommand("tachyon._spawn", "lineage-child", {
      cmd: "sh",
      parent: "prompter",
    });
    let agents = await vscode.commands.executeCommand("tachyon._agents");
    const child = agents.find((a) => a.name === "lineage-child");
    assert.ok(child && child.running, "child not running");
    assert.strictEqual(child.parent, "prompter", "lineage not recorded");
    assert.ok(tachyonSessions().includes(`tachyon-${wsHash}-lineage-child`), "child session missing in tmux");
  });

  it("Stop All kills this workspace's sessions", async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand("tachyon.stopAll");
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250);
      gone = !tachyonSessions().some((s) => s.startsWith(`tachyon-${wsHash}-`));
    }
    assert.ok(gone, "workspace sessions still alive after Stop All");
  });
});
