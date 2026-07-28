/**
 * t-b88106 — real-VSCode dogfood for agent surface preservation.
 *
 * The reported defect: restarting an agent that was working headless made its terminal appear as an
 * editor tab, interrupting the human and changing UI state nobody asked to change. Unit tests pin the
 * RULE; this pins the OBSERVABLE OUTCOME in a real extension host — real `vscode.window.terminals`,
 * real tmux sessions, real lifecycle commands, no Tachyon Companion involved.
 *
 * Runs under `npm run test:integration` (vscode-test, single-root suite).
 */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Editor terminals presenting this agent. `Terminals` names the tab after the agent. */
function surfacesFor(agent) {
  return vscode.window.terminals.filter((t) => t.name === agent);
}

/** Close every editor surface for an agent and wait until VSCode has really disposed them. */
async function goHeadless(agent) {
  for (const terminal of surfacesFor(agent)) terminal.dispose();
  for (let i = 0; i < 40 && surfacesFor(agent).length > 0; i++) await sleep(50);
  assert.strictEqual(surfacesFor(agent).length, 0, `could not take '${agent}' headless`);
}

/**
 * `t-fe40c9` — reach headless by CLOSING a surface, and prove a surface was there to close.
 *
 * `goHeadless` alone is satisfied by an agent that never had a tab, so a scenario built on it can
 * pass — or fail — for a reason that has nothing to do with the rule under test. That is not
 * hypothetical: this suite's first real run reported the t-b88106 defect on a host where the agent's
 * surface had never appeared, and the tab that broke the assertion came from a present-intent that
 * outlived an earlier editor host (`t-9b5acb`). Measured from a clean session, all six scenarios pass.
 *
 * Opening first also makes the scenario the one the incident describes: an agent that WAS visible,
 * that a human then closed, and that is relaunched afterwards.
 */
async function goHeadlessFromVisible(agent, wsHash) {
  await goHeadless(agent);
  await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, wsHash);
  for (let i = 0; i < 60 && surfacesFor(agent).length === 0; i++) await sleep(50);
  assert.strictEqual(
    surfacesFor(agent).length,
    1,
    `precondition failed: '${agent}' never showed a surface, so "headless" would be vacuous`,
  );
  await goHeadless(agent);
}

/** Wait for a settled view of an agent's surfaces after a lifecycle action. */
async function settle(ms = 1500) {
  await sleep(ms);
}

function tmuxAlive(session) {
  try {
    execFileSync("tmux", ["-L", TMUX_SOCKET, "has-session", "-t", `=${session}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("t-b88106 — a relaunch preserves an agent's visual state", () => {
  const AGENT = "prompter"; // declared + autostart in the fixture workspace
  let wsHash;
  let session;

  before(async function () {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "test host opened no workspace");
    wsHash = workspaceHash(folder.uri.fsPath);
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(ext, "extension not found in the test host");
    await ext.activate();
    session = `tachyon-${wsHash}-${AGENT}`;
    // Autostart is asynchronous; the agent must exist before its lifecycle means anything.
    for (let i = 0; i < 60 && !tmuxAlive(session); i++) await sleep(250);
    if (!tmuxAlive(session)) {
      // On a host where this suite cannot bring a Tachyon workspace up, EVERY scenario here would
      // report a surface bug that is really an absent agent. Skip loudly rather than assert something
      // this environment cannot show. Measured 2026-07-26 on this machine: the whole single-root suite
      // fails identically on `main` (6 passing / 17 failing, no agent ever spawns), so the blocker is
      // the harness, not the code under test — filed separately. Unit coverage of the same behavior
      // through the real Workspace/AgentManager/Terminals wiring lives in
      // `test/unit/workspaceSurfaceLifecycle.test.ts` and does run everywhere.
      // Print what the EXTENSION HOST itself sees, so the next person reads evidence, not a guess:
      // `activate()` returns early when `doctor()` reports no usable tmux, and that early return is a
      // notification rather than a thrown error, so nothing lands in exthost.log.
      let tmuxVersion;
      try {
        tmuxVersion = execFileSync("tmux", ["-V"], { encoding: "utf8" }).trim();
      } catch (err) {
        tmuxVersion = `unavailable to the extension host: ${err instanceof Error ? err.message : String(err)}`;
      }
      let sessions;
      try {
        sessions = execFileSync("tmux", ["-L", TMUX_SOCKET, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      } catch {
        sessions = [];
      }
      console.log(`[t-b88106] SKIPPED — the editor host never spawned ${session}.`);
      console.log(`[t-b88106]   tmux as seen by the extension host: ${tmuxVersion}`);
      console.log(`[t-b88106]   PATH: ${process.env.PATH}`);
      console.log(`[t-b88106]   tachyon sessions on ${TMUX_SOCKET}: ${sessions.join(", ") || "(none)"}`);
      this.skip();
    }
  });

  const item = () => ({ agentName: AGENT, workspaceHash: wsHash });

  it("restarting a HEADLESS agent opens no editor terminal", async () => {
    await goHeadlessFromVisible(AGENT, wsHash);

    await vscode.commands.executeCommand("tachyon.restartAgentItem", item());
    await settle();

    assert.deepStrictEqual(
      surfacesFor(AGENT).map((t) => t.name),
      [],
      "restarting a headless agent materialized an editor terminal — the t-b88106 defect",
    );
    assert.ok(tmuxAlive(session), "the agent itself should still be running after restart");
  });

  it("restarting a headless agent does not steal focus to some other terminal either", async () => {
    await goHeadlessFromVisible(AGENT, wsHash);
    const activeBefore = vscode.window.activeTerminal?.name ?? null;

    await vscode.commands.executeCommand("tachyon.restartAgentItem", item());
    await settle();

    assert.strictEqual(vscode.window.activeTerminal?.name ?? null, activeBefore, "restart changed terminal focus");
  });

  it("force+new restart of a headless agent also stays headless", async () => {
    await goHeadlessFromVisible(AGENT, wsHash);

    // The force+new section is what crash recovery and watch-restart use, so it must obey the same
    // rule — those relaunches are not even human-initiated.
    await vscode.commands.executeCommand("tachyon.restartAgentForceNewItem", item());
    await settle(2500);

    assert.deepStrictEqual(surfacesFor(AGENT).map((t) => t.name), [], "force+new restart materialized a terminal");
  });

  it("restarting a VISIBLE agent restores its surface without duplicating it", async () => {
    await goHeadless(AGENT);
    await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", AGENT, wsHash);
    await settle();
    assert.strictEqual(surfacesFor(AGENT).length, 1, "opening the agent terminal did not produce exactly one tab");

    await vscode.commands.executeCommand("tachyon.restartAgentItem", item());
    await settle(2500);

    assert.strictEqual(
      surfacesFor(AGENT).length,
      1,
      `a visible agent must keep exactly one surface across restart (found ${surfacesFor(AGENT).length})`,
    );
  });

  it("opening a terminal twice reveals the existing tab instead of creating a second", async () => {
    await goHeadless(AGENT);
    await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", AGENT, wsHash);
    await settle();
    await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", AGENT, wsHash);
    await settle();

    assert.strictEqual(surfacesFor(AGENT).length, 1, "re-opening duplicated the agent's editor terminal");
  });

  it("stopping the agent closes its surface", async () => {
    await goHeadless(AGENT);
    await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", AGENT, wsHash);
    await settle();
    assert.strictEqual(surfacesFor(AGENT).length, 1);

    await vscode.commands.executeCommand("tachyon.killAgentItem", item());
    await settle(2500);

    assert.deepStrictEqual(surfacesFor(AGENT).map((t) => t.name), [], "a killed agent left its editor terminal behind");
    assert.ok(!tmuxAlive(session), "kill did not end the tmux session");
  });

  after(async () => {
    await goHeadless(AGENT).catch(() => undefined);
  });
});
