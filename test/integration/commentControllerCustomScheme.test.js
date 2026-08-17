const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await sleep(50);
  }
  assert.fail(message);
}

function sameUri(left, right) {
  return left.toString(true) === right.toString(true);
}

async function probeCommentSurface({ name, base, modified, expectedLine }) {
  const commentingRangeCalls = [];
  const controller = vscode.comments.createCommentController(`tachyon.comment-uri-probe.${name}`, `Comment URI probe: ${name}`);
  controller.commentingRangeProvider = {
    provideCommentingRanges(document) {
      commentingRangeCalls.push(document.uri);
      return [new vscode.Range(expectedLine, 0, expectedLine, Number.MAX_SAFE_INTEGER)];
    },
  };

  let thread;
  try {
    await vscode.commands.executeCommand("vscode.diff", base, modified, `Comment URI probe: ${name}`);

    const modifiedEditor = await waitFor(
      () => vscode.window.visibleTextEditors.find((editor) => sameUri(editor.document.uri, modified)),
      `${name}: modified document never became a visible side of the diff`,
    );
    const baseEditor = await waitFor(
      () => vscode.window.visibleTextEditors.find((editor) => sameUri(editor.document.uri, base)),
      `${name}: base document never became a visible side of the diff`,
    );
    await waitFor(
      () => commentingRangeCalls.some((uri) => sameUri(uri, modified)),
      `${name}: VS Code never requested commenting ranges for the modified document`,
    );

    const range = new vscode.Range(expectedLine, 0, expectedLine, 5);
    thread = controller.createCommentThread(modified, range, [{
      body: `probe ${name}`,
      mode: vscode.CommentMode.Preview,
      author: { name: "Tachyon integration probe" },
    }]);

    // 1. Association is observable through both the visible diff document and the returned thread URI.
    assert.ok(sameUri(modifiedEditor.document.uri, thread.uri), `${name}: thread is not associated with the visible modified document`);
    // 2. Both sides are open, and the thread belongs only to the modified URI.
    assert.ok(!sameUri(baseEditor.document.uri, thread.uri), `${name}: thread was associated with the base side`);
    // 3. A commenting-range request is VS Code's observable contract for rendering the ruler affordance.
    assert.ok(
      commentingRangeCalls.some((uri) => sameUri(uri, modified)),
      `${name}: modified document received no commenting-range request`,
    );
    // 4. The platform gives the exact range back after thread creation.
    assert.ok(thread.range, `${name}: thread.range became undefined`);
    assert.ok(thread.range.isEqual(range), `${name}: thread.range did not survive round-trip`);

    return {
      scheme: modified.scheme,
      baseVisible: baseEditor.document.uri.toString(true),
      modifiedVisible: modifiedEditor.document.uri.toString(true),
      commentingRangeRequests: commentingRangeCalls.filter((uri) => sameUri(uri, modified)).length,
      range: `${thread.range.start.line}:${thread.range.start.character}-${thread.range.end.line}:${thread.range.end.character}`,
    };
  } finally {
    thread?.dispose();
    controller.dispose();
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  }
}

describe("CommentController custom-scheme probe (t-1c7627)", () => {
  it("associates a ranged thread and ruler affordance with the modified read-only URI, with file control", async function () {
    this.timeout(30000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "test host opened no workspace");

    const scheme = `tachyon-comment-probe-${Date.now()}`;
    const content = new Map([
      ["/base.txt", "base line\nshared line\n"],
      ["/modified.txt", "modified line\nshared line\n"],
    ]);
    const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent(uri) {
        return content.get(uri.path) ?? "";
      },
    });

    const fileDir = path.join(folder.uri.fsPath, ".tachyon", "comment-uri-probe");
    const fileBase = vscode.Uri.file(path.join(fileDir, "base.txt"));
    const fileModified = vscode.Uri.file(path.join(fileDir, "modified.txt"));
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(fileBase.fsPath, content.get("/base.txt"));
    fs.writeFileSync(fileModified.fsPath, content.get("/modified.txt"));

    try {
      const virtual = await probeCommentSurface({
        name: "custom-read-only",
        base: vscode.Uri.from({ scheme, path: "/base.txt" }),
        modified: vscode.Uri.from({ scheme, path: "/modified.txt" }),
        expectedLine: 0,
      });
      const file = await probeCommentSurface({
        name: "file-control",
        base: fileBase,
        modified: fileModified,
        expectedLine: 0,
      });

      assert.notStrictEqual(virtual.scheme, "file", "virtual probe accidentally used a file URI");
      assert.strictEqual(file.scheme, "file", "negative control did not use file URIs");
      console.log(`[t-1c7627] VS Code ${vscode.version} virtual=${JSON.stringify(virtual)} file=${JSON.stringify(file)}`);
    } finally {
      provider.dispose();
      fs.rmSync(fileDir, { recursive: true, force: true });
    }
  });
});
