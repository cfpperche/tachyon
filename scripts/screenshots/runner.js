/**
 * In-host screenshot driver (extensionTestsPath). Picks a SCENE from the
 * environment, choreographs the extension, and hand-shakes with capture.sh via
 * marker files in $SHOTDIR (writes `ready`, waits for `done`) so an outside
 * ffmpeg grabs the frame at the right moment.
 *
 * Scenes (env SCENE): hero | observability | lineage | studio | multiroot | inspector | commands | pins | schedules | walkthrough | worktree | review
 * Run one per invocation (see capture.sh). Targets the committed examples.
 */
const vscode = require("vscode");
const fs = require("fs");
const { execFileSync } = require("child_process");

const SHOTDIR = process.env.SHOTDIR || "/tmp/tachyon-shots";
const SCENE = process.env.SCENE || "hero";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function frame(name) {
  fs.writeFileSync(`${SHOTDIR}/ready-${name}`, "");
  for (let i = 0; i < 120 && !fs.existsSync(`${SHOTDIR}/done-${name}`); i++) await sleep(500);
}
async function tidy() {
  for (const c of ["workbench.action.closeAuxiliaryBar", "workbench.action.closePanel", "notifications.clearAll"]) {
    try { await vscode.commands.executeCommand(c); } catch {}
  }
}
function keys(session, text) {
  execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "-l", "--", text], { stdio: "pipe" });
  execFileSync("tmux", ["-L", "tachyon", "send-keys", "-t", `=${session}:`, "C-m"], { stdio: "pipe" });
}
const split = (a, b) => vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{ size: a }, { size: b }] });
async function openIn(group, agent, hash) {
  await vscode.commands.executeCommand(group === 1 ? "workbench.action.focusFirstEditorGroup" : "workbench.action.focusSecondEditorGroup");
  await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, hash);
}

exports.run = async function run() {
  await vscode.extensions.getExtension("cfpperche.tachyon").activate();
  await sleep(2500);
  await tidy();
  await vscode.commands.executeCommand("workbench.view.extension.tachyon");
  const wss = await vscode.commands.executeCommand("tachyon._workspaces");
  const hash = wss[0].hash;
  await vscode.commands.executeCommand("tachyon.start");
  await sleep(2500);

  if (SCENE === "hero") {
    try { await vscode.commands.executeCommand("tachyon._spawn", "codex"); } catch {}
    await sleep(1500);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await split(0.55, 0.45);
    await openIn(1, "claude"); await sleep(900);
    await openIn(2, "codex"); await sleep(900);
    await vscode.commands.executeCommand("workbench.view.extension.tachyon");
    await tidy(); await sleep(15000);
    keys(`tachyon-${hash}-claude`, "Use the tachyon MCP tool write_input to send to agent 'codex' (submit true): please review src/routes/missions.js for input validation issues");
    await sleep(45000); await tidy();
    await frame("hero");
  } else if (SCENE === "observability") {
    for (const a of ["asker", "watcher", "crashy"]) { try { await vscode.commands.executeCommand("tachyon._spawn", a, { cmd: "sh" }); } catch {} }
    await sleep(1500);
    keys(`tachyon-${hash}-asker`, "printf 'Apply the migration? [y/n] '");
    keys(`tachyon-${hash}-crashy`, "exit 7");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await tidy(); await sleep(14000); await tidy();
    await frame("observability");
  } else if (SCENE === "lineage") {
    try { await vscode.commands.executeCommand("tachyon._spawn", "worker", { cmd: "claude", parent: "claude", instructions: "research the auth flow; save findings with set_notes" }); } catch {}
    await sleep(1200);
    try { await vscode.commands.executeCommand("tachyon._spawn", "researcher", { cmd: "claude", parent: "worker" }); } catch {}
    await sleep(1500);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await split(0.6, 0.4);
    await openIn(1, "claude"); await sleep(900);
    await openIn(2, "worker"); await sleep(900);
    await vscode.commands.executeCommand("workbench.view.extension.tachyon");
    await tidy(); await sleep(15000); await tidy();
    await frame("lineage");
  } else if (SCENE === "studio") {
    const tabs = [
      ["agent", () => vscode.commands.executeCommand("tachyon.agentStudio")],
      ["terminal", () => vscode.commands.executeCommand("tachyon.editAgentStudioItem", { agentName: "dev" })],
      ["command", () => vscode.commands.executeCommand("tachyon.editCommandStudioItem", { commandName: "test" })],
      ["runbook", () => vscode.commands.executeCommand("tachyon.editRunbookStudioItem", { runbookName: "ship" })],
      ["schedule", () => vscode.commands.executeCommand("tachyon.editScheduleStudioItem", { scheduleName: "hourly-tests" })],
    ];
    for (const [name, open] of tabs) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await sleep(400);
      await vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{}] });
      try { await open(); } catch {}
      await sleep(3200); await tidy();
      await frame(`studio-${name}`);
    }
  } else if (SCENE === "multiroot") {
    const api = wss.find((w) => w.folder === "orbit-api") || wss[0];
    const wrk = wss.find((w) => w.folder === "orbit-worker") || wss[1];
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await split(0.55, 0.45);
    await openIn(1, "claude", api.hash); await sleep(900);
    if (wrk) await openIn(2, "worker", wrk.hash); await sleep(900);
    await vscode.commands.executeCommand("workbench.view.extension.tachyon");
    await tidy(); await sleep(13000);
    await vscode.commands.executeCommand("tachyon.refreshViews");
    await sleep(1200); await tidy();
    await frame("multiroot");
  } else if (SCENE === "inspector") {
    // Populate the server with a spread of session kinds: agents, a terminal,
    // a crashed pane, and a one-shot command run — then open the inspector.
    try { await vscode.commands.executeCommand("tachyon._spawn", "codex"); } catch {}
    for (const a of ["builder", "crashy"]) { try { await vscode.commands.executeCommand("tachyon._spawn", a, { cmd: "sh" }); } catch {} }
    await sleep(1200);
    keys(`tachyon-${hash}-crashy`, "exit 3");
    try { await vscode.commands.executeCommand("tachyon._runCommand", "lint", hash); } catch {}
    await sleep(2500);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{}] });
    await vscode.commands.executeCommand("tachyon.inspectServer");
    await sleep(3500); await tidy();
    await frame("inspector");
  } else if (SCENE === "commands") {
    await vscode.commands.executeCommand("tachyon._runCommand", "lint", hash);
    await sleep(1500);
    await vscode.commands.executeCommand("tachyon._runCommand", "test", hash);
    await sleep(2500);
    try { await vscode.commands.executeCommand("tachyon._runRunbook", "ship", hash); } catch {}
    await sleep(3000);
    await vscode.commands.executeCommand("tachyon._commandTick", hash);
    await vscode.commands.executeCommand("tachyon.refreshViews");
    await vscode.commands.executeCommand("tachyonTree.focus");
    await sleep(1500); await tidy();
    await frame("commands");
  } else if (SCENE === "pins") {
    await vscode.commands.executeCommand("tachyon._pin", "auth uses a deprecated JWT lib — flag for upgrade", "codex", false, hash);
    await vscode.commands.executeCommand("tachyon._pin", "POST /missions has no input validation", "claude", false, hash);
    await vscode.commands.executeCommand("tachyon._pin", "added rate-limit middleware to /api", "claude", true, hash);
    await sleep(800);
    await vscode.commands.executeCommand("tachyon.refreshViews");
    await vscode.commands.executeCommand("tachyonTree.focus");
    await sleep(1500); await tidy();
    await frame("pins");
  } else if (SCENE === "schedules") {
    await vscode.commands.executeCommand("tachyon._togglePause", "hourly-tests", hash);
    await vscode.commands.executeCommand("tachyon._propose", "nightly-audit", { at: "02:00", run: "test" }, "run the suite nightly to catch drift before standup", hash);
    await sleep(800);
    await vscode.commands.executeCommand("tachyon.refreshViews");
    await vscode.commands.executeCommand("tachyonTree.focus");
    await sleep(1500); await tidy();
    await frame("schedules");
  } else if (SCENE === "walkthrough") {
    await vscode.commands.executeCommand("tachyon.getStarted");
    await sleep(4000); await tidy();
    await frame("walkthrough");
  } else if (SCENE === "resume") {
    // claude autostarts (mint -> ledger entry). Kill it so it's stopped WITH a
    // saved session -> the sidebar shows the "resumable" badge (spec 209 / F29 UX).
    await sleep(2500);
    try { await vscode.commands.executeCommand("tachyon.killAgentItem", { agentName: "claude" }); } catch {}
    await sleep(1500);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("tachyon.refreshViews");
    await sleep(1200); await tidy();
    await frame("resume");
  } else if (SCENE === "worktree") {
    // The worktree loop (spec 210/214). Spawn the `feature` agent in its OWN git
    // worktree (⎇ badge) — cheaply as `sh` so it's deterministic headless (the
    // declared feature in tachyon.yml supplies `verify: test`). Then run Verify →
    // the ✓ badge. Needs a standalone-git workspace (tachyon-examples), which is why
    // the rig targets it. The worktree path comes from the ledger (robust vs XDG).
    const root = wss[0].root;
    try { await vscode.commands.executeCommand("tachyon._spawn", "feature", { cmd: "sh", worktree: true }); } catch {}
    await sleep(3500);
    let wt;
    try { wt = JSON.parse(fs.readFileSync(`${root}/.tachyon/sessions.json`, "utf8")).sessions.feature.worktree.path; } catch {}
    // A fresh worktree has no node_modules — link the main tree's so `npm test` runs.
    if (wt) { try { execFileSync("bash", ["-c", `ln -sfn "${root}/node_modules" "${wt}/node_modules"`], { stdio: "pipe" }); } catch {} }
    try { await vscode.commands.executeCommand("tachyon.verifyAgentItem", { agentName: "feature" }); } catch {}
    await sleep(8000); // npm test runs in the worktree
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("tachyon.refreshViews");
    await vscode.commands.executeCommand("tachyonTree.focus");
    await sleep(1500); await tidy();
    await frame("worktree");
  } else if (SCENE === "review") {
    // C2 diff-review — the agent's branch vs the base, in VS Code's native diff editor.
    const root = wss[0].root;
    try { await vscode.commands.executeCommand("tachyon._spawn", "feature", { cmd: "sh", worktree: true }); } catch {}
    await sleep(3500);
    let wt;
    try { wt = JSON.parse(fs.readFileSync(`${root}/.tachyon/sessions.json`, "utf8")).sessions.feature.worktree.path; } catch {}
    if (wt) { try { execFileSync("bash", ["-c", `printf '\\n// reviewed on the feature branch\\nexport const REVIEWED = true;\\n' >> "${wt}/orbit-api/src/routes/missions.js"`], { stdio: "pipe" }); } catch {} }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{}] });
    if (wt) {
      const base = vscode.Uri.file(`${root}/orbit-api/src/routes/missions.js`);
      const cur = vscode.Uri.file(`${wt}/orbit-api/src/routes/missions.js`);
      await vscode.commands.executeCommand("vscode.diff", base, cur, "missions.js (main ↔ feature worktree)");
    }
    await sleep(3000); await tidy();
    await frame("review");
  }

  try { await vscode.commands.executeCommand("tachyon.stopAll"); } catch {}
  await sleep(800);
};
