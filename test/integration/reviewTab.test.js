/**
 * t-9dafd3 — SDD 513 fatia 3 headless proof in a real Extension Development Host.
 *
 * Slice 3 retired `comments.ts` and the CommentController. The remaining claim is the
 * one a worktree agent cannot fake: the review command opens the Tachyon tab, the
 * native vscode.diff tab does not open, and writing a note does not reveal or resize
 * a VS Code panel. That last one is why 513 exists — the Comments panel used to take
 * the bottom bar on its own.
 *
 * A Temporary spawn with `cmd: sleep` is refused (measured on the first run): Tachyon
 * will not admit a non-LLM as an agent. The review command is the same function for
 * an agent worktree and a managed change worktree (`reviewWorktreeDiff` → ReviewPanel).
 * This test builds a change worktree with a committed file change and opens it through
 * `tachyon.reviewWorktreeItem`. It does not touch ReviewPanel.ts or the review webview.
 */
const assert = require("node:assert");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const SLUG = "revtab";
const FILE = "src/app.js";
const LINE_TEXT = "module.exports = { ok: true };";
const ADDED_LINE = "module.exports.reviewed = true;";
const REVIEW_VIEW = "tachyonReview";
const BRANCH = `tachyon/change/${SLUG}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t-9dafd3",
      GIT_AUTHOR_EMAIL: "t-9dafd3@example.invalid",
      GIT_COMMITTER_NAME: "t-9dafd3",
      GIT_COMMITTER_EMAIL: "t-9dafd3@example.invalid",
    },
  });
}

function managedId(kind, key) {
  const digest = crypto.createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 16);
  const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 32);
  return `mw-${kind}-${safe}-${digest}`;
}

async function waitFor(predicate, message, timeoutMs = 20000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const last = await predicate();
    if (last) return last;
    await sleep(stepMs);
  }
  assert.fail(message);
}

function describeTabs() {
  const rows = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      let viewType = null;
      if (input && typeof input === "object" && "viewType" in input) {
        viewType = String(/** @type {{ viewType: unknown }} */ (input).viewType);
      }
      rows.push({
        label: tab.label,
        inputCtor: input?.constructor?.name ?? typeof input,
        viewType,
        column: group.viewColumn ?? null,
      });
    }
  }
  return rows;
}

function reviewTabs() {
  return describeTabs().filter((row) => {
    if (row.viewType === REVIEW_VIEW || (row.viewType && row.viewType.endsWith(REVIEW_VIEW))) return true;
    return row.inputCtor === "TabInputWebview" && String(row.label).includes("Review");
  });
}

function nativeDiffTabs() {
  return describeTabs().filter((row) => row.inputCtor === "TabInputTextDiff");
}

function workbenchSnapshot() {
  const groups = vscode.window.tabGroups.all.map((group) => ({
    column: group.viewColumn ?? null,
    tabs: group.tabs.length,
  }));
  return {
    tabs: describeTabs(),
    groups,
    visibleEditors: vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString(true)).sort(),
    activeLabel: vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? null,
  };
}

function persistProductNote(root, worktree, baseRef) {
  const commentId = `c${Date.now().toString(36)}t9dafd3`;
  const dir = path.join(root, ".tachyon", "review", worktree, commentId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1,
    identity: { worktree, baseRef, path: FILE, side: "modified", commentId },
    snapshot: { line: 1, lineText: LINE_TEXT, before: [], after: [ADDED_LINE], k: 3 },
    body: "check the caller",
    status: "active",
    range: { startLine: 1, endLine: 1 },
    lastPath: FILE,
    lastLine: 1,
  };
  fs.writeFileSync(path.join(dir, "record.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

function writeManagedRegistry(root, entry) {
  const file = path.join(root, ".tachyon", "managed-worktrees.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, entries: [entry] }, null, 2)}\n`, { mode: 0o600 });
}

describe("t-9dafd3 — Tachyon review tab in the Extension Development Host", () => {
  const leftovers = [];

  after(async function () {
    this.timeout(20000);
    for (const dir of leftovers) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    try { git(["worktree", "prune"], folder.uri.fsPath); } catch { /* best effort */ }
    try { git(["branch", "-D", BRANCH], folder.uri.fsPath); } catch { /* best effort */ }
  });

  it("opens the Tachyon tab, does not open vscode.diff, and a note write reveals nothing", async function () {
    this.timeout(90000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "test host opened no workspace");
    const root = folder.uri.fsPath;

    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    assert.ok(ext, "extension not found in the test host");
    await ext.activate();
    assert.strictEqual(ext.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("tachyon.reviewWorktreeItem"), "review command is not registered");

    const mine = await waitFor(
      async () => {
        const workspaces = (await vscode.commands.executeCommand("tachyon._workspaces")) ?? [];
        return workspaces.find((ws) => ws.root === root) ?? workspaces[0];
      },
      "no Tachyon workspace registered after activate",
      20000,
      200,
    );
    assert.ok(mine.hash, `workspace has no hash: ${JSON.stringify(mine)}`);
    const wsHash = mine.hash;

    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, FILE), `${LINE_TEXT}\n`, "utf8");
    git(["init", "-q", "-b", "main"], root);
    git(["config", "user.email", "t-9dafd3@example.invalid"], root);
    git(["config", "user.name", "t-9dafd3"], root);
    git(["add", FILE], root);
    git(["commit", "-q", "-m", "root"], root);
    const baseRef = git(["rev-parse", "HEAD"], root).trim();

    const wt = path.join(path.dirname(root), `${SLUG}-wt`);
    leftovers.push(wt);
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* none */ }
    try { git(["worktree", "prune"], root); } catch { /* none */ }
    try { git(["branch", "-D", BRANCH], root); } catch { /* none */ }
    git(["worktree", "add", "-q", "-b", BRANCH, wt, "HEAD"], root);
    fs.appendFileSync(path.join(wt, FILE), `${ADDED_LINE}\n`, "utf8");
    git(["add", FILE], wt);
    git(["commit", "-q", "-m", "reviewable change"], wt);

    const worktreeId = managedId("change", SLUG);
    writeManagedRegistry(root, {
      id: worktreeId,
      kind: "change",
      path: wt,
      branch: BRANCH,
      baseRef,
      tachyonCreatedBranch: true,
      slug: SLUG,
      createdAt: new Date().toISOString(),
      createdBy: "t-9dafd3",
      status: "active",
    });

    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    if (open.length > 0) await vscode.window.tabGroups.close(open, false);
    try { await vscode.commands.executeCommand("workbench.action.closePanel"); } catch { /* panel already closed */ }
    await sleep(300);

    await vscode.commands.executeCommand("tachyon.reviewWorktreeItem", {
      worktreeId,
      workspaceHash: wsHash,
    });
    await waitFor(
      () => reviewTabs().length > 0,
      `Tachyon review tab did not open; tabs: ${JSON.stringify(describeTabs())}`,
      15000,
      100,
    );

    const reviews = reviewTabs();
    assert.strictEqual(reviews.length, 1, `expected one Tachyon review tab, got ${JSON.stringify(reviews)}`);
    assert.ok(
      reviews[0].viewType === REVIEW_VIEW || (reviews[0].viewType && reviews[0].viewType.endsWith(REVIEW_VIEW)),
      `review tab viewType is not ${REVIEW_VIEW}: ${JSON.stringify(reviews[0])}`,
    );

    const diffs = nativeDiffTabs();
    assert.deepStrictEqual(
      diffs,
      [],
      `native vscode.diff tab opened; that is the surface 513 retired: ${JSON.stringify(diffs)}`,
    );

    const beforeNote = workbenchSnapshot();
    persistProductNote(root, worktreeId, baseRef);
    await sleep(1500);
    const afterNote = workbenchSnapshot();
    assert.deepStrictEqual(
      afterNote,
      beforeNote,
      "writing a review note revealed or resized the workbench (tabs, groups, or visible editors changed)",
    );
  });
});
