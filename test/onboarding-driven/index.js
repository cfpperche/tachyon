const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

/**
 * t-505f13 — the DRIVEN onboarding path: empty workspace → first entry running, each step
 * affirmed through the door PRODUCTION uses (view focus for activation, tachyon.openOnboarding for
 * the tab, tachyon.init for the bootstrap — the exact command the app's button executes — and the
 * spawn operation for the first session). A screenshot proves none of this; every step here
 * asserts state, not pixels.
 *
 * The fixture workspace this suite opens is EMPTY on purpose: `workspaceContains:tachyon.yml` must
 * not fire, so step 2 can prove the extension is genuinely dormant until the Tachyon view is
 * opened — the onView activation event this card adds.
 */

const TMUX_SOCKET = process.env.TACHYON_TMUX_SOCKET || "tachyon";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmuxSessions() {
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

async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "test host opened no workspace");
  const root = folder.uri.fsPath;
  const wsHash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 8);
  const asserts = [];
  const step = (id, ok, detail) => {
    asserts.push({ id, ok: !!ok, detail: detail ?? "" });
    if (!ok) console.error(`[onboarding-driven] FAIL ${id}: ${detail ?? ""}`);
    else console.log(`[onboarding-driven] ok   ${id}${detail ? ` — ${detail}` : ""}`);
    assert.ok(ok, `${id}: ${detail ?? "failed"}`);
  };

  // ── 1. The premise: this workspace has no Tachyon configuration. ─────────────────────────────
  step("empty-workspace", !fs.existsSync(path.join(root, "tachyon.yml")), "fixture has no tachyon.yml");

  // ── 2. Dormant before the door: workspaceContains did not fire. ──────────────────────────────
  const ext = vscode.extensions.getExtension("cfpperche.tachyon");
  assert.ok(ext, "extension not loaded (check extensionDevelopmentPath)");
  step("inactive-before-view", ext.isActive === false, `isActive=${ext.isActive}`);

  // ── 3. THE onView DOOR: opening the Tachyon panel activates the extension. ────────────────────
  await vscode.commands.executeCommand("tachyonSidebarPrototype.focus");
  for (let i = 0; i < 50 && !ext.isActive; i += 1) await sleep(100);
  step("activated-by-view-focus", ext.isActive === true, "onView:tachyonSidebarPrototype focused");

  // ── 4. The onboarding tab opens in the editor area. ─────────────────────────────────────────
  await vscode.commands.executeCommand("tachyon.openOnboarding");
  await sleep(1500);
  const labels = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  step("onboarding-tab-open", labels.includes("Onboarding"), `tabs=${JSON.stringify(labels)}`);

  // ── 5. Bootstrap through the SAME command the app's Initialize button runs. ──────────────────
  await vscode.commands.executeCommand("tachyon.init");
  await sleep(500);
  const configPath = path.join(root, "tachyon.yml");
  step("tachyon-yml-written", fs.existsSync(configPath), configPath);
  const gitignore = fs.existsSync(path.join(root, ".gitignore"))
    ? fs.readFileSync(path.join(root, ".gitignore"), "utf8")
    : "";
  step("gitignore-patched", gitignore.includes(".tachyon/sessions.json"), "machine-local state ignored");

  // ── 6. The folder is now a Tachyon workspace: the spawn door answers for it. ─────────────────
  // (Before bootstrap this folder had no workspace; the roster read below can only succeed once
  // the engine attached — which is the claim, and the roster is honestly empty until step 7.)
  let roster;
  for (let i = 0; i < 60; i += 1) {
    try {
      roster = await vscode.commands.executeCommand("tachyon._agents");
      break;
    } catch {
      await sleep(500);
    }
  }
  step("workspace-attached", Array.isArray(roster), "engine answers agents.list for the new workspace");
  const shellDeclared = fs.readFileSync(configPath, "utf8").includes("shell:");
  step("starter-shell-declared", shellDeclared, "starter config ships the shell entry");

  // ── 7. FIRST ENTRY RUNNING: start the starter shell and prove a live tmux session. ───────────
  await vscode.commands.executeCommand("tachyon._spawn", "shell", undefined, wsHash);
  const expected = `tachyon-${wsHash}-shell`;
  let sessions = [];
  for (let i = 0; i < 60; i += 1) {
    sessions = tmuxSessions();
    if (sessions.includes(expected)) break;
    await sleep(500);
  }
  step("first-entry-running", sessions.includes(expected), `tmux sessions=${JSON.stringify(sessions)}`);

  const out = process.env.ONBOARDING_DRIVEN_RESULT;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({ asserts }, null, 2)}\n`, "utf8");
  }
  console.log(`[onboarding-driven] ${asserts.length} steps affirmed`);
}

module.exports = { run };
