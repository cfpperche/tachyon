import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitHookStore, argvWrapperScript } from "../../src/plugins/gitHookRegistry.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function ws(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ghdisp-")); dirs.push(d); return d; }

function shOk(): boolean {
  try { execFileSync("sh", ["-c", "command -v sha256sum || command -v shasum"], { stdio: "ignore" }); return true; } catch { return false; }
}

/** A leaf that records its name to $OUT and exits `code`. */
function leaf(name: string, code: number): string {
  return `#!/bin/sh\nprintf '%s\\n' "${name}" >> "$OUT"\nexit ${code}\n`;
}

/** Run a store's pre-commit dispatcher; return {code, out lines}. */
function runDispatcher(store: GitHookStore, root: string, extraEnv: Record<string, string> = {}): { code: number; out: string[] } {
  const outFile = path.join(root, "out.txt");
  fs.writeFileSync(outFile, "");
  try {
    execFileSync("sh", [store.dispatcherFile("pre-commit")], { cwd: root, env: { ...process.env, OUT: outFile, ...extraEnv }, stdio: "ignore" });
    return { code: 0, out: read(outFile) };
  } catch (e) {
    return { code: (e as { status?: number }).status ?? 1, out: read(outFile) };
  }
}
const read = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);

describe.skipIf(!shOk())("git-hook dispatcher (spec 264, executed)", () => {
  function install(root: string, leaves: Array<{ name: string; code: number }>): GitHookStore {
    const store = new GitHookStore(root);
    const steps = leaves.map((l) => `leaves/${store.putLeaf(leaf(l.name, l.code))}`);
    store.installEventArtifacts("pre-commit", steps);
    return store;
  }

  it("passes (exit 0) when every step exits 0", () => {
    const root = ws();
    const store = install(root, [{ name: "A", code: 0 }, { name: "B", code: 0 }]);
    expect(runDispatcher(store, root)).toEqual({ code: 0, out: ["A", "B"] });
  });

  it("run-all-aggregate: every step runs, the first non-zero exit propagates", () => {
    const root = ws();
    const store = install(root, [{ name: "A", code: 0 }, { name: "B", code: 3 }, { name: "C", code: 0 }]);
    const r = runDispatcher(store, root);
    expect(r.code).toBe(3); // first non-zero
    expect(r.out).toEqual(["A", "B", "C"]); // ALL ran (run-all, not fail-fast)
  });

  it("preserves Git's env and adds TACHYON_GITHOOK_EVENT", () => {
    const root = ws();
    const store = new GitHookStore(root);
    const h = store.putLeaf(`#!/bin/sh\nprintf '%s %s\\n' "$TACHYON_GITHOOK_EVENT" "$MY_GIT_ENV" >> "$OUT"\n`);
    store.installEventArtifacts("pre-commit", [`leaves/${h}`]);
    const r = runDispatcher(store, root, { MY_GIT_ENV: "xyz" });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["pre-commit xyz"]);
  });

  it("fail-closed on a tampered manifest (integrity mismatch)", () => {
    const root = ws();
    const store = install(root, [{ name: "A", code: 0 }]);
    fs.appendFileSync(path.join(store.dir(), "pre-commit.run"), "leaves/injected\n"); // body changed, integrity stale
    expect(runDispatcher(store, root).code).toBe(1);
  });

  it("fail-closed when a step leaf is missing", () => {
    const root = ws();
    const store = new GitHookStore(root);
    store.installEventArtifacts("pre-commit", ["leaves/deadbeef"]); // referenced leaf never put → not executable
    expect(runDispatcher(store, root).code).toBe(1);
  });

  it("an argv-wrapper leaf execs the declared command", () => {
    const root = ws();
    const store = new GitHookStore(root);
    const h = store.putLeaf(argvWrapperScript(["/bin/sh", "-c", 'printf ok\\\\n >> "$OUT"']));
    store.installEventArtifacts("pre-commit", [`leaves/${h}`]);
    const r = runDispatcher(store, root);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["ok"]);
  });
});
