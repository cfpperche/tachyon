import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  GitHookStore,
  argvWrapperScript,
  GIT_HOOK_STDIN_EVENTS,
  gitHookStdinEventsAreAllowlisted,
  DISPATCHER_TEMPLATE_VERSION,
  dispatcherTemplateFingerprint,
  readDispatcherTemplateVersion,
  dispatcherScript,
} from "../../apps/vscode-extension/src/plugins/gitHookRegistry.js";
import { GIT_HOOK_EVENTS } from "@tachyon/engine/plugins/manifest.js";

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

/** Run any event's dispatcher with `input` on stdin; return {code, and whatever each leaf wrote to $OUT}. */
function runWithStdin(
  store: GitHookStore,
  root: string,
  event: string,
  input: string,
): { code: number; out: string[] } {
  const outFile = path.join(root, "out.txt");
  fs.writeFileSync(outFile, "");
  try {
    execFileSync("sh", [store.dispatcherFile(event)], {
      cwd: root,
      env: { ...process.env, OUT: outFile },
      input,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return { code: 0, out: read(outFile) };
  } catch (e) {
    return { code: (e as { status?: number }).status ?? 1, out: read(outFile) };
  }
}

/** A leaf that copies EVERYTHING it reads on stdin into $OUT, tagged with its name. */
function stdinEchoLeaf(name: string): string {
  return `#!/bin/sh\nwhile IFS= read -r L; do printf '%s:%s\\n' "${name}" "$L" >> "$OUT"; done\nprintf '%s:EOF\\n' "${name}" >> "$OUT"\n`;
}

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

  // ── stdin contract (t-6a8deb) ────────────────────────────────────────────
  // `pre-push` IS a stdin contract: git feeds one line per ref and a gate cannot scope itself to a
  // protected branch without them. The dispatcher used to read its own manifest on fd 0, so every leaf
  // inherited an exhausted manifest instead — a branch-scoped gate found no refs and passed every push.

  const REFS =
    "refs/heads/main aaaa1111 refs/heads/main bbbb2222\n" +
    "refs/heads/topic cccc3333 refs/heads/topic dddd4444\n";

  it("pre-push: git's ref lines reach the leaf intact", () => {
    const root = ws();
    const store = new GitHookStore(root);
    const h = store.putLeaf(stdinEchoLeaf("A"));
    store.installEventArtifacts("pre-push", [`leaves/${h}`]);
    expect(runWithStdin(store, root, "pre-push", REFS)).toEqual({
      code: 0,
      out: [
        "A:refs/heads/main aaaa1111 refs/heads/main bbbb2222",
        "A:refs/heads/topic cccc3333 refs/heads/topic dddd4444",
        "A:EOF",
      ],
    });
  });

  it("pre-push: EVERY leaf in the chain sees the same stdin (a pipe is single-read)", () => {
    const root = ws();
    const store = new GitHookStore(root);
    const a = store.putLeaf(stdinEchoLeaf("A"));
    const b = store.putLeaf(stdinEchoLeaf("B"));
    store.installEventArtifacts("pre-push", [`leaves/${a}`, `leaves/${b}`]);
    const r = runWithStdin(store, root, "pre-push", REFS);
    expect(r.code).toBe(0);
    // Buffering is what makes this pass: forwarding git's pipe directly would starve B.
    expect(r.out.filter((l) => l.startsWith("B:"))).toEqual([
      "B:refs/heads/main aaaa1111 refs/heads/main bbbb2222",
      "B:refs/heads/topic cccc3333 refs/heads/topic dddd4444",
      "B:EOF",
    ]);
    expect(r.out.filter((l) => l.startsWith("A:"))).toHaveLength(3);
  });

  it("pre-push: a leaf that refuses on what it read propagates its exit code", () => {
    const root = ws();
    const store = new GitHookStore(root);
    // Refuses only when a ref line targets main — the real shape of a branch-scoped gate.
    const h = store.putLeaf(
      `#!/bin/sh\nwhile IFS= read -r L; do\n  case "$L" in *"refs/heads/main "*) printf 'refused\\n' >> "$OUT"; exit 7;; esac\ndone\nexit 0\n`,
    );
    store.installEventArtifacts("pre-push", [`leaves/${h}`]);
    expect(runWithStdin(store, root, "pre-push", REFS)).toEqual({ code: 7, out: ["refused"] });
    // ...and stays out of the way when no protected ref is in the push.
    expect(runWithStdin(store, root, "pre-push", "refs/heads/topic c3 refs/heads/topic d4\n")).toEqual({
      code: 0,
      out: [],
    });
  });

  it("pre-commit: a leaf gets /dev/null, never the dispatcher's own manifest", () => {
    const root = ws();
    const store = new GitHookStore(root);
    const h = store.putLeaf(stdinEchoLeaf("A"));
    store.installEventArtifacts("pre-commit", [`leaves/${h}`]);
    // Feed bytes git would never send: an event with no stdin contract must not forward them either.
    expect(runWithStdin(store, root, "pre-commit", "leaves/injected\n")).toEqual({ code: 0, out: ["A:EOF"] });
  });

  it("the stdin-contract set cannot drift from the manifest allowlist", () => {
    expect(gitHookStdinEventsAreAllowlisted(GIT_HOOK_EVENTS)).toEqual({ ok: true, unknown: [] });
    expect(GIT_HOOK_STDIN_EVENTS.has("pre-push")).toBe(true);
    expect(gitHookStdinEventsAreAllowlisted(["pre-commit"])).toEqual({ ok: false, unknown: ["pre-push"] });
  });

  // ── template version stamp (t-c3b0a5) ────────────────────────────────────

  it("stamps the generated dispatcher with the current template version", () => {
    const root = ws();
    const store = install(root, [{ name: "A", code: 0 }]);
    expect(readDispatcherTemplateVersion(store.dispatcherFile("pre-commit"))).toBe(DISPATCHER_TEMPLATE_VERSION);
    // and it stays where a reader can find it without executing anything.
    expect(fs.readFileSync(store.dispatcherFile("pre-commit"), "utf8").split("\n")[2])
      .toBe(`# tachyon-dispatcher-template ${DISPATCHER_TEMPLATE_VERSION}`);
  });

  it("an UNSTAMPED dispatcher reads as version 1, not as current", () => {
    const root = ws();
    const store = install(root, [{ name: "A", code: 0 }]);
    const stripped = dispatcherScript("pre-commit")
      .split("\n")
      .filter((l) => !l.startsWith("# tachyon-dispatcher-template "))
      .join("\n");
    fs.writeFileSync(store.dispatcherFile("pre-commit"), stripped);
    expect(readDispatcherTemplateVersion(store.dispatcherFile("pre-commit"))).toBe(1);
    // an absent file is unknown — NOT "current", so a caller can never mistake it for up to date.
    expect(readDispatcherTemplateVersion(path.join(root, "nope"))).toBeNull();
  });

  // THE forcing function for the whole mechanism: a version nobody increments is decoration, and the
  // reconciler would then never fire for a real behavior change. If this fails because you edited
  // `dispatcherScript`, that is the test working: bump DISPATCHER_TEMPLATE_VERSION and update this hash.
  it("changing the template body without bumping the version fails the suite", () => {
    expect({ version: DISPATCHER_TEMPLATE_VERSION, fingerprint: dispatcherTemplateFingerprint() }).toEqual({
      version: 2,
      fingerprint: "96a2876684c3a0916475bb08cceafe22e44de08f386e7e3dfad0c48267d572cf",
    });
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
