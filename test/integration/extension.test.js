const assert = require("node:assert");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

/**
 * t-05097f — the gate talks to the tmux server the EXTENSION is using, not the shared default.
 * `.vscode-test.mjs` gives each run a unique `TACHYON_TMUX_SOCKET`; hardcoding `-L tachyon` here
 * pointed these helpers at the fleet's server instead, which is how a "Stop All" scenario came to
 * list real running agents and how sessions leaked between runs.
 */
const TMUX_SOCKET = process.env.TACHYON_TMUX_SOCKET || "tachyon";

function workspaceHash(p) {
  return crypto.createHash("sha256").update(p).digest("hex").slice(0, 8);
}

function tachyonSessions() {
  try {
    return execFileSync("tmux", ["-L", TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"], {
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

  before(async function () {
    this.timeout(90000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "test host opened no workspace");
    wsHash = workspaceHash(folder.uri.fsPath);

    // t-9418ac — autostart is asynchronous, so give the declared entries a chance to appear ONCE,
    // here, instead of letting whichever scenario happens to run first absorb the wait. This does
    // not assert: a missing entry is reported by the scenario that actually needs it, so one
    // flaky spawn cannot mask the 17 scenarios that have nothing to do with it.
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(ext, "extension not found in the test host");
    await ext.activate();

    const expected = ["echoer", "prompter", "flaky"].map((n) => `tachyon-${wsHash}-${n}`);
    let missing = expected;
    for (let i = 0; i < 120 && missing.length > 0; i++) {
      await sleep(250);
      const live = tachyonSessions();
      missing = expected.filter((s) => !live.includes(s));
    }
    if (missing.length > 0) {
      // Measured 2026-07-27 (t-9418ac): with the fixture's config now VALID, the workspace loads all
      // three entries and `start()` reports "3 started" — yet no `tmux new-session` is ever issued
      // for them. That is the original bucket-1 defect, finally isolated with the config ruled out;
      // it is filed separately. Print evidence rather than guessing.
      const entries = (await vscode.commands.executeCommand("tachyon._agents")) ?? [];
      console.log(`[t-9418ac] declared entries not in tmux: ${missing.join(", ")}`);
      console.log(`[t-9418ac] workspace view: ${JSON.stringify(entries.map((e) => ({ n: e.name, k: e.kind, run: e.running, dead: e.dead })))}`);
      console.log(`[t-9418ac] live sessions: ${tachyonSessions().join(", ") || "(none)"}`);
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
    // spec 237 retired the native tree, leaving the Preact webview as the sidebar. spec 349 then
    // added the plugin surface host as a second contributed view (t-9418ac: this assertion still
    // listed only the first and had been failing ever since, independently of where the suite runs).
    assert.deepStrictEqual(
      contributes.views.tachyon.map((v) => v.id),
      ["tachyonSidebarPrototype", "tachyonPluginSurfaces"],
    );
    assert.strictEqual(contributes.views.tachyon.find((v) => v.id === "tachyonSidebarPrototype")?.type, "webview");
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
      "tachyon.init",
      "tachyon.stopAll",
      "tachyon.restartAgent",
      "tachyon.openAgentTerminal",
      "tachyon.copyBridgeUrl",
      "tachyon.connectRuntime",
    ]) {
      assert.ok(commands.includes(cmd), `missing command ${cmd}`);
    }
  });

  it("spawns the autostart terminal into a real tmux session (spec scenario 1)", async function () {
    this.timeout(20000);
    // Readiness is established once in `before`; this pins the observable outcome.
    const expected = `tachyon-${wsHash}-echoer`;
    assert.ok(
      tachyonSessions().includes(expected),
      `session ${expected} not found; sessions: ${tachyonSessions().join(", ")}`,
    );
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
      ["-L", TMUX_SOCKET, "display-message", "-p", "-t", `=${session}:`, "#{session_created}"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    assert.strictEqual(created, expected, "survivor was restarted (creation time changed) or killed");
  });

  // spec 234 — the layout integration tests were removed (layouts feature retired).

  it("restarts the terminal when a watched file changes (spec scenario 5)", async function () {
    this.timeout(30000);
    const fs = require("node:fs");
    const path = require("node:path");
    const session = `tachyon-${wsHash}-echoer`;
    const createdOf = () => {
      try {
        return execFileSync("tmux", ["-L", TMUX_SOCKET, "display-message", "-p", "-t", `=${session}:`, "#{session_created}"], {
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
    assert.ok(after, "echoer not running after watch restart");
  });

  it("detects a real prompt as needs-input (spec 188 scenario 1)", async function () {
    this.timeout(45000);
    const session = `tachyon-${wsHash}-prompter`;
    // `prompter` is a TERMINAL that opts into attention. The pane poller is runtime-agnostic, so
    // what this proves is the live plumbing — real 3s poll, real tmux, real `tachyon._attention`.
    // The pattern semantics themselves are covered headless in test/unit/attention.test.ts.
    let alive = false;
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(250);
      alive = tachyonSessions().includes(session);
    }
    assert.ok(alive, "prompter terminal not running");
    execFileSync(
      "tmux",
      ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "-l", "--", "printf 'Do you want to continue? [y/n] '"],
      { stdio: "pipe" },
    );
    execFileSync("tmux", ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });

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
    execFileSync("tmux", ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "-l", "--", "y"], { stdio: "pipe" });
    execFileSync("tmux", ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });
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
    const session = `tachyon-${wsHash}-prompter`; // terminal, restart: never (default)
    execFileSync("tmux", ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "-l", "--", "exit 3"], { stdio: "pipe" });
    execFileSync("tmux", ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });

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

  it("restart: on-crash auto-restarts a crashed terminal (spec 190)", async function () {
    this.timeout(60000);
    const session = `tachyon-${wsHash}-flaky`;
    let alive = false;
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(250);
      alive = tachyonSessions().includes(session);
    }
    assert.ok(alive, "flaky terminal not running before the crash test");
    execFileSync("tmux", ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "-l", "--", "exit 5"], { stdio: "pipe" });
    execFileSync("tmux", ["-L", TMUX_SOCKET, "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });

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

  it("does not register the retired quick inline-agent command", async function () {
    this.timeout(20000);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(!commands.includes("tachyon.newAgent"), "retired quick inline-agent command is still registered");
  });

  it("legacy Agent Studio submissions fail closed and direct users to canonical Agent Studio", async function () {
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
      let errors = await vscode.commands.executeCommand("tachyon._upsertAgent", { state });
      assert.ok(errors && errors.some((e) => e.includes("inline agent editing is retired")), "legacy submit should fail closed");
      assert.strictEqual(fs.readFileSync(ymlPath, "utf8"), original, "legacy submit must not write tachyon.yml");

      // t-8247ec — where the refusal points. Canonical Agent Studio is a Control route since
      // t-610705 Phase D, not a tab of its own, so the command opens the Control panel; this half
      // of the scenario was unreachable while the submit above died in transport. Close Control
      // first so what follows proves THIS command opened it rather than reading a panel an earlier
      // scenario left behind. Being open is the observable, not being focused: another editor tab
      // can win focus back in the headless host.
      const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label.includes("Control"));
      if (open.length > 0) await vscode.window.tabGroups.close(open, false);
      await sleep(300);
      await vscode.commands.executeCommand("tachyon.agentStudio");
      await sleep(1000);
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
      assert.ok(tabs.some((l) => l.includes("Control")), `Control panel not opened by the studio command; tabs: ${tabs.join(", ")}`);
    } finally {
      fs.writeFileSync(ymlPath, original, "utf8");
    }
  });

  // t-9418ac — two scenarios left this suite deliberately, because both could only run by spawning
  // `cmd: sh` and calling it an agent:
  //
  //   * "lineage: spawn with parent" (spec 197). Lineage is IDENTITY, and identity is agent-only —
  //     a terminal has no parent to inherit from, so this cannot be re-based on `terminals:` without
  //     asserting something the product does not mean. Covered headless in test/unit/agentManager.test.ts ("lineage (spec 197)").
  //   * "wait_for_agent resolves on a real transition" (spec 198). Covered headless in
  //     test/unit/waiters.test.ts, which drives every branch this exercised (arrival, terminal
  //     events, gone, timeout, independent settlement) against the real Waiters state machine.
  //
  // Neither is a coverage loss: what the editor host added was a fake process standing in for a
  // runtime. An editor-host E2E for agent semantics is reserved for a real LLM runtime.

  it("one-shot command: pass and fail, own namespace, postmortem pane kept (spec 199)", async function () {
    this.timeout(30000);
    const statusOf = async (name) => (await vscode.commands.executeCommand("tachyon._commands")).find((c) => c.name === name);

    await vscode.commands.executeCommand("tachyon._runCommand", "hello");
    assert.ok(tachyonSessions().includes(`tachyon-cmd-${wsHash}-hello`), "command session missing");
    let st;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      await vscode.commands.executeCommand("tachyon._commandTick");
      st = await statusOf("hello");
      if (st && st.state === "passed") break;
    }
    assert.ok(st && st.state === "passed", `hello should pass: ${JSON.stringify(st)}`);
    assert.strictEqual(st.exitCode, 0);

    await vscode.commands.executeCommand("tachyon._runCommand", "failer");
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      await vscode.commands.executeCommand("tachyon._commandTick");
      st = await statusOf("failer");
      if (st && st.state === "failed") break;
    }
    assert.ok(st && st.state === "failed", `failer should fail: ${JSON.stringify(st)}`);
    assert.strictEqual(st.exitCode, 7);
    // postmortem: the dead pane survives, and the command never entered the agent list
    assert.ok(tachyonSessions().includes(`tachyon-cmd-${wsHash}-failer`), "failed pane should be kept");
    const agents = await vscode.commands.executeCommand("tachyon._agents");
    assert.ok(!agents.some((a) => a.name === "hello" || a.name === "failer"), "commands leaked into the agent list");
  });

  it("runbook: sequential pass; failure gates and skips the rest (spec 200)", async function () {
    this.timeout(45000);
    const job = await vscode.commands.executeCommand("tachyon._runRunbook", "ship");
    assert.strictEqual(job.outcome, "passed", `ship should pass: ${JSON.stringify(job)}`);
    assert.deepStrictEqual(job.steps.map((s) => s.state), ["passed", "passed"]);
    assert.ok(!tachyonSessions().some((s) => s.startsWith(`tachyon-rb-${wsHash}-ship-`)), "successful step panes should be tidied");

    const doomed = await vscode.commands.executeCommand("tachyon._runRunbook", "doomed");
    assert.strictEqual(doomed.outcome, "failed");
    assert.deepStrictEqual(doomed.steps.map((s) => s.state), ["passed", "failed", "skipped"]);
    assert.strictEqual(doomed.steps[1].exitCode, 7);
    assert.ok(tachyonSessions().includes(`tachyon-rb-${wsHash}-doomed-1`), "failed step pane should be kept for postmortem");

    const runbooks = await vscode.commands.executeCommand("tachyon._runbooks");
    const entry = runbooks.find((r) => r.name === "doomed");
    assert.ok(entry && entry.lastJob && entry.lastJob.outcome === "failed", "runbook list should expose the last job");
  });

  it("runbook CRUD through the Studio pipeline (spec 201)", async function () {
    this.timeout(20000);
    const fs = require("node:fs");
    const path = require("node:path");
    const ymlPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "tachyon.yml");
    const original = fs.readFileSync(ymlPath, "utf8");
    const state = {
      name: "release",
      cmd: "",
      kind: "runbook",
      instructions: "",
      watch: "",
      steps: "hello\n  echo inline  \n",
      cwd: "",
      autostart: false,
      restartOnCrash: false,
      attention: false,
    };
    try {
      // create through the same pipeline the webview submit uses
      let errors = await vscode.commands.executeCommand("tachyon._upsertAgent", { state });
      assert.strictEqual(errors, undefined, `unexpected errors: ${JSON.stringify(errors)}`);
      assert.match(fs.readFileSync(ymlPath, "utf8"), /release:/);
      let runbooks = await vscode.commands.executeCommand("tachyon._runbooks");
      assert.ok(runbooks.some((r) => r.name === "release"), "release not listed after upsert");

      // empty steps block
      errors = await vscode.commands.executeCommand("tachyon._upsertAgent", { state: { ...state, name: "bad", steps: " \n " } });
      assert.ok(errors && errors.length > 0, "empty steps should block");

      // edit-in-place
      errors = await vscode.commands.executeCommand("tachyon._upsertAgent", {
        state: { ...state, steps: "hello" },
        editingName: "release",
      });
      assert.strictEqual(errors, undefined);

      // delete (force skips the modal)
      await vscode.commands.executeCommand("tachyon.deleteRunbookItem", { runbookName: "release" }, true);
      runbooks = await vscode.commands.executeCommand("tachyon._runbooks");
      assert.ok(!runbooks.some((r) => r.name === "release"), "release still listed after delete");
    } finally {
      fs.writeFileSync(ymlPath, original, "utf8");
    }
  });

  it("Tachyon: Init never clobbers an existing tachyon.yml (spec 205)", async function () {
    this.timeout(15000);
    const fs = require("node:fs");
    const path = require("node:path");
    const ymlPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "tachyon.yml");
    const before = fs.readFileSync(ymlPath, "utf8");
    // the fixture folder already has a tachyon.yml -> Init must refuse (no overwrite).
    // showInformationMessage returns undefined headless, so the refuse path just returns.
    await vscode.commands.executeCommand("tachyon.init");
    await sleep(300);
    assert.strictEqual(fs.readFileSync(ymlPath, "utf8"), before, "Init must not modify an existing tachyon.yml");
  });

  it("schedules: declared schedule is active; agent proposal stays pending until approved (spec 206)", async function () {
    this.timeout(20000);
    const fs = require("node:fs");
    const path = require("node:path");
    const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const ymlPath = path.join(wsRoot, "tachyon.yml");
    const original = fs.readFileSync(ymlPath, "utf8");
    try {
      // the fixture declares schedules.hourly-hello -> active
      const active = await vscode.commands.executeCommand("tachyon._schedules");
      assert.ok(active.some((s) => s.name === "hourly-hello"), `hourly-hello not active: ${JSON.stringify(active)}`);

      // simulate an agent proposal landing in the pending file, then approve it
      fs.mkdirSync(path.join(wsRoot, ".tachyon"), { recursive: true });
      fs.writeFileSync(
        path.join(wsRoot, ".tachyon", "schedules-pending.json"),
        JSON.stringify({ proposals: [{ id: "pp1", name: "nightly-test", by: "claude", createdAt: "2026-06-11T00:00:00Z", schedule: { every: "2h", run: "hello" } }] }, null, 2),
      );
      let pending = await vscode.commands.executeCommand("tachyon._proposals");
      assert.ok(pending.some((p) => p.id === "pp1"), "proposal not listed");
      // pending proposals never appear as active schedules
      let act = await vscode.commands.executeCommand("tachyon._schedules");
      assert.ok(!act.some((s) => s.name === "nightly-test"), "pending proposal must NOT be active");

      // approve -> written into tachyon.yml, dropped from pending, now active
      // t-9418ac — `_approveProposal` reports a RESULT object now, not a bare boolean. Same class of
      // rot as the sidebar-views assertion: the command is right, the expectation was stale.
      const ok = await vscode.commands.executeCommand("tachyon._approveProposal", "pp1");
      assert.strictEqual(ok && ok.changed, true, `approve failed: ${JSON.stringify(ok)}`);
      await sleep(400);
      assert.match(fs.readFileSync(ymlPath, "utf8"), /nightly-test:/);
      pending = await vscode.commands.executeCommand("tachyon._proposals");
      assert.ok(!pending.some((p) => p.id === "pp1"), "approved proposal should leave the pending list");
      act = await vscode.commands.executeCommand("tachyon._schedules");
      assert.ok(act.some((s) => s.name === "nightly-test"), "approved schedule should be active");

      // reject path: add another, reject it
      fs.writeFileSync(
        path.join(wsRoot, ".tachyon", "schedules-pending.json"),
        JSON.stringify({ proposals: [{ id: "pp2", name: "junk", by: "codex", createdAt: "2026-06-11T00:00:00Z", schedule: { every: "1h", run: "hello" } }] }, null, 2),
      );
      await vscode.commands.executeCommand("tachyon._rejectProposal", "pp2");
      pending = await vscode.commands.executeCommand("tachyon._proposals");
      assert.ok(!pending.some((p) => p.id === "pp2"), "rejected proposal should be gone");
    } finally {
      fs.writeFileSync(ymlPath, original, "utf8");
      fs.rmSync(path.join(wsRoot, ".tachyon"), { recursive: true, force: true });
    }
  });

  it("Stop All kills this workspace's sessions (agents + commands + runbook panes)", async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand("tachyon.stopAll");
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250);
      gone = !tachyonSessions().some((s) => s.includes(`-${wsHash}-`));
    }
    assert.ok(gone, `workspace sessions still alive after Stop All: ${tachyonSessions().join(", ")}`);
  });
});
