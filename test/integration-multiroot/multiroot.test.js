const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

/**
 * Multi-root host (spec 204 / F9): the window opens multi.code-workspace with
 * TWO folders (alpha, beta), each carrying its own tachyon.yml. One Workspace
 * per folder: distinct wsHash namespaces, distinct Bridges, isolated agents.
 */

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

describe("Tachyon multi-root (spec 204)", () => {
  let alpha, beta;

  before(async function () {
    this.timeout(20000);
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(ext, "extension not found");
    await ext.activate();
    // both folders register
    let list = [];
    for (let i = 0; i < 40 && list.length < 2; i++) {
      await sleep(250);
      list = await vscode.commands.executeCommand("tachyon._workspaces");
    }
    alpha = list.find((w) => w.folder === "alpha");
    beta = list.find((w) => w.folder === "beta");
    assert.ok(alpha && beta, `expected alpha+beta, got ${JSON.stringify(list)}`);
  });

  after(async function () {
    this.timeout(15000);
    await vscode.commands.executeCommand("tachyon.stopAll");
    for (const session of tachyonSessions()) {
      if (alpha && session.includes(alpha.hash)) {
        try { execFileSync("tmux", ["-L", "tachyon", "kill-session", "-t", `=${session}`], { stdio: "pipe" }); } catch { /* gone */ }
      }
      if (beta && session.includes(beta.hash)) {
        try { execFileSync("tmux", ["-L", "tachyon", "kill-session", "-t", `=${session}`], { stdio: "pipe" }); } catch { /* gone */ }
      }
    }
  });

  it("one Workspace per folder: distinct hashes and distinct Bridge ports", () => {
    assert.notStrictEqual(alpha.hash, beta.hash, "folders must namespace separately");
    assert.ok(alpha.bridge && beta.bridge, "both Bridges must be running");
    assert.notStrictEqual(alpha.bridge, beta.bridge, "each folder gets its own Bridge");
  });

  it("alpha's autostart agent runs in alpha's namespace only", async function () {
    this.timeout(20000);
    const expected = `tachyon-${alpha.hash}-alpha-agent`;
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await sleep(250);
      found = tachyonSessions().includes(expected);
    }
    assert.ok(found, `session ${expected} not found; sessions: ${tachyonSessions().join(", ")}`);
    // beta has no autostart — nothing of beta's runs
    assert.ok(!tachyonSessions().some((s) => s.includes(beta.hash) && !s.startsWith("tachyon-ctl")), "beta should be quiet");
  });

  it("agent listings are folder-scoped (hash arg routes the seam)", async () => {
    const alphaAgents = await vscode.commands.executeCommand("tachyon._agents", alpha.hash);
    const betaAgents = await vscode.commands.executeCommand("tachyon._agents", beta.hash);
    assert.ok(alphaAgents.some((a) => a.name === "alpha-agent"), "alpha-agent missing from alpha");
    assert.ok(!alphaAgents.some((a) => a.name === "beta-agent"), "beta-agent leaked into alpha");
    assert.ok(betaAgents.some((a) => a.name === "beta-agent"), "beta-agent missing from beta");
    assert.ok(!betaAgents.some((a) => a.name === "alpha-agent"), "alpha-agent leaked into beta");
  });

  it("spawning in beta does not touch alpha; killing beta leaves alpha running", async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand("tachyon._spawn", "beta-agent", undefined, beta.hash);
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(250);
      up = tachyonSessions().includes(`tachyon-${beta.hash}-beta-agent`);
    }
    assert.ok(up, "beta-agent did not spawn in beta's namespace");

    // kill beta's agent only
    const sessions = tachyonSessions();
    execFileSync("tmux", ["-L", "tachyon", "kill-session", "-t", `=tachyon-${beta.hash}-beta-agent`], { stdio: "pipe" });
    await sleep(500);
    assert.ok(tachyonSessions().includes(`tachyon-${alpha.hash}-alpha-agent`), "alpha must survive beta's kill");
    assert.ok(sessions.includes(`tachyon-${beta.hash}-beta-agent`), "sanity: beta was running before the kill");
  });

  it("commands are folder-scoped too", async () => {
    const alphaCmds = await vscode.commands.executeCommand("tachyon._commands", alpha.hash);
    const betaCmds = await vscode.commands.executeCommand("tachyon._commands", beta.hash);
    assert.ok(alphaCmds.some((c) => c.name === "alpha-check"), "alpha-check missing");
    assert.strictEqual(betaCmds.length, 0, "beta declares no commands");
  });

  it("both Bridges enforce auth independently", async function () {
    this.timeout(15000);
    for (const ws of [alpha, beta]) {
      const res = await fetch(ws.bridge, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.strictEqual(res.status, 401, `${ws.folder} Bridge must reject unauthenticated calls`);
    }
  });
});
