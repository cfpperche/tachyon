import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __resetVscodeMock } from "../mocks/vscode.js";
import { PluginsPanelManager, sourceSpecAtCommit } from "../../src/webview/PluginsPanel.js";
import { serializeLockfile, LOCKFILE_REL_PATH } from "../../src/plugins/lockfile.js";
import type { WorkspaceGitPresentationTarget } from "../../src/shell/WorkspacePresentation.js";

/**
 * t-0fc9ee — the Control → Plugins embed's SESSION lifecycle across the shell's 3s poll.
 *
 * The shell routes every poll tick through bindControlEmbed(); the embed session's checks/pending/
 * busy live in that call's closure. Before this fix a same-scope rebind recreated the closure, so a
 * just-found update check vanished in ≤3s (the visible bug), a pending consent drawer was orphaned
 * (confirmOp found no pending and silently returned), and the busy guard was forgotten. These tests
 * pin the contract: SAME webview + SAME workspace → refresh only; a NEW session only on first
 * entry, a real workspace switch, or a replaced webview; leaving the section unbinds.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-embed-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A sourced plugin entry — the source makes checkPluginUpdate reach gitExec, which fails fast. */
function writeLockfile(root: string, name: string): void {
  const lockPath = path.join(root, LOCKFILE_REL_PATH);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const entry = {
    name,
    version: "1.0.0",
    runtimes: ["claude"],
    targets: [{ runtime: "claude", kind: "settings-hook", file: ".claude/settings.json", ref: "PreToolUse", removal: [{ hooks: [{ type: "command", command: "echo guard" }] }] }],
    source: { type: "git", spec: `github:acme/${name}@v1.0.0`, remote: `https://github.com/acme/${name}.git`, ref: "v1.0.0", resolvedCommit: "a1b2c3d".padEnd(40, "0") },
    integrity: { algorithm: "sha256", payload: "deadbeef" },
  };
  fs.writeFileSync(lockPath, serializeLockfile({ schemaVersion: 1, plugins: { [name]: entry } } as never));
  // the remove plan reads the target runtime config — present-but-empty keeps previewRemove error-free
  // so it yields a REAL consent fingerprint (an empty fingerprint never reaches confirm: the "confirm"
  // dispatch case requires a truthy token).
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, "{}\n");
}

/** Offline-deterministic target: every git call fails fast (no network, no real repo). */
function target(root: string, hash: string): WorkspaceGitPresentationTarget {
  return {
    workspaceRoot: root,
    wsHash: hash,
    folderName: `ws-${hash}`,
    gitExec: async () => ({ code: 1, stdout: "", stderr: "fake git: unavailable" }),
  } as unknown as WorkspaceGitPresentationTarget;
}

interface FakeWebview {
  posted: Array<Record<string, unknown>>;
  postMessage(m: unknown): Thenable<boolean>;
}

function fakeWebview(): FakeWebview {
  const posted: Array<Record<string, unknown>> = [];
  return { posted, postMessage: (m) => { posted.push(m as Record<string, unknown>); return Promise.resolve(true); } };
}

function managerFor(targets: WorkspaceGitPresentationTarget[]): PluginsPanelManager {
  return new PluginsPanelManager(Uri.file("/ext"), () => targets);
}

const pluginsMsgs = (wv: FakeWebview) =>
  wv.posted.filter((m) => m.type === "plugins") as Array<{ vm: { installed: Array<{ name: string; status: { kind: string } }> } }>;

const statusOf = (wv: FakeWebview, name: string): string | undefined =>
  pluginsMsgs(wv).at(-1)?.vm.installed.find((p) => p.name === name)?.status.kind;

describe("Reinstall source pin", () => {
  it("replaces a movable ref with the recorded commit while preserving a monorepo subdir", () => {
    expect(sourceSpecAtCommit("github:acme/plugins@v2.3.1#path=diagram", "c".repeat(40)))
      .toBe(`github:acme/plugins@${"c".repeat(40)}#path=diagram`);
  });

  // A single-plugin repo has no `#path=` fragment, and the ref is still the LAST '@' — the same rule
  // `parseSource`'s `splitRef` applies. Pinned separately because this helper is a second copy of that
  // split: if the spec grammar ever grows a locator that can hold an '@', both have to move together.
  it("pins a spec with no monorepo subdir", () => {
    expect(sourceSpecAtCommit("github:acme/tdd-guard@v1.0.0", "d".repeat(40)))
      .toBe(`github:acme/tdd-guard@${"d".repeat(40)}`);
  });

  /**
   * The routing half. `buildReinstallConsent` proves the drawer's SHAPE; this proves the `reinstall`
   * message reaches the new door at all, and that the door pins the recorded COMMIT rather than the
   * movable ref it was installed from.
   *
   * Before the fix the same message was routed to `previewUpdateOp(…, force: true)`, which resolves
   * `source.ref`. The failing resolve names what it tried to fetch, so the message the human gets is
   * itself the evidence of which door ran — no spying on internals required.
   */
  it("routes reinstall to the pinned-commit door, not to force-update on the movable ref", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1")]);
    const wv = fakeWebview();
    mgr.bindControlEmbed(wv as never, "ws-1");

    mgr.handleControlEmbedMessage({ type: "reinstall", name: "tdd-guard" } as never);
    await flush();

    const result = wv.posted.find((m) => m.type === "result") as { ok: boolean; message: string } | undefined;
    expect(result?.ok).toBe(false); // the fake git cannot fetch; what matters is WHICH fetch was attempted
    expect(result?.message).toContain("a1b2c3d".padEnd(40, "0").slice(0, 12));
  });
});

describe("Control → Plugins embed session lifecycle (t-0fc9ee)", () => {
  it("a same-scope rebind (the shell's 3s poll) preserves a stored update check", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const ws = target(root, "ws-1");
    const mgr = managerFor([ws]);
    const wv = fakeWebview();

    mgr.bindControlEmbed(wv as never, "ws-1");
    expect(statusOf(wv, "tdd-guard")).toBe("unknown"); // no check ran yet

    // the check settles into an error (fake git fails) — a REAL stored result, distinct from unknown
    mgr.handleControlEmbedMessage({ type: "checkPluginUpdate", name: "tdd-guard" } as never);
    await flush();
    expect(statusOf(wv, "tdd-guard")).toBe("error");

    // the shell's next poll tick re-binds the SAME webview + workspace — the check must survive
    mgr.bindControlEmbed(wv as never, "ws-1");
    expect(statusOf(wv, "tdd-guard")).toBe("error"); // pre-fix: wiped back to "unknown"
  });

  it("a pending consent survives a same-scope rebind — confirm still applies instead of silently dropping", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const ws = target(root, "ws-1");
    const mgr = managerFor([ws]);
    const wv = fakeWebview();
    mgr.bindControlEmbed(wv as never, "ws-1");

    mgr.handleControlEmbedMessage({ type: "remove", name: "tdd-guard" } as never);
    await flush();
    const consent = wv.posted.find((m) => m.type === "consent") as { vm: { token: string } } | undefined;
    expect(consent?.vm.token).toBeTruthy();

    // poll tick between the drawer opening and the human clicking Confirm
    mgr.bindControlEmbed(wv as never, "ws-1");

    mgr.handleControlEmbedMessage({ type: "confirm", token: consent!.vm.token } as never);
    await flush();
    // pre-fix: the rebound session had no pending — confirmOp silently returned, NO result ever posted
    const result = wv.posted.find((m) => m.type === "result") as { ok: boolean; message: string } | undefined;
    expect(result).toBeTruthy();
  });

  it("a REAL workspace switch resets the session (stored checks do not leak across workspaces)", async () => {
    const rootA = mkroot();
    const rootB = mkroot();
    writeLockfile(rootA, "tdd-guard");
    writeLockfile(rootB, "tdd-guard");
    const mgr = managerFor([target(rootA, "ws-a"), target(rootB, "ws-b")]);
    const wv = fakeWebview();

    mgr.bindControlEmbed(wv as never, "ws-a");
    mgr.handleControlEmbedMessage({ type: "checkPluginUpdate", name: "tdd-guard" } as never);
    await flush();
    expect(statusOf(wv, "tdd-guard")).toBe("error");

    mgr.bindControlEmbed(wv as never, "ws-b");
    expect(statusOf(wv, "tdd-guard")).toBe("unknown"); // fresh session: ws-a's check must not apply to ws-b
  });

  it("a replaced webview creates a fresh session even for the same workspace", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1")]);
    const first = fakeWebview();

    mgr.bindControlEmbed(first as never, "ws-1");
    mgr.handleControlEmbedMessage({ type: "checkPluginUpdate", name: "tdd-guard" } as never);
    await flush();
    expect(statusOf(first, "tdd-guard")).toBe("error");

    const second = fakeWebview();
    mgr.bindControlEmbed(second as never, "ws-1");
    expect(statusOf(second, "tdd-guard")).toBe("unknown");
  });

  it("leaving the section unbinds: messages stop routing and refresh posts nothing", async () => {
    const root = mkroot();
    writeLockfile(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1")]);
    const wv = fakeWebview();
    mgr.bindControlEmbed(wv as never, "ws-1");
    mgr.unbindControlEmbed();

    const before = wv.posted.length;
    expect(mgr.handleControlEmbedMessage({ type: "checkPluginUpdate", name: "tdd-guard" } as never)).toBe(false);
    mgr.refreshControlEmbed();
    await flush();
    expect(wv.posted.length).toBe(before);
  });
});

/**
 * t-fb216a — the HOST half of the runtime-coverage gap. `buildPluginsViewModel` computing
 * `declared ∩ present − lock.runtimes` is worth nothing if the panel never injects `declared`;
 * that injection is fs I/O in the vscode layer, which unit tests otherwise never reach.
 *
 * These drive the real gather() through the embed and assert on the POSTED view-model.
 */
describe("runtime-coverage gap reaches the posted view-model (t-fb216a)", () => {
  /** the installed payload manifest — the bytes this install materialized, which is what Reinstall re-materializes. */
  function writePayloadManifest(root: string, name: string, runtimes: string[]): void {
    const dir = path.join(root, ".tachyon/plugins", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "test", runtimes }));
  }

  const uncoveredOf = (wv: FakeWebview, name: string): string[] | undefined =>
    (pluginsMsgs(wv).at(-1)?.vm.installed.find((p) => p.name === name) as { uncoveredRuntimes?: string[] } | undefined)?.uncoveredRuntimes;

  it("names grok when the payload declares it, the workspace runs it, and the lockfile never covered it", () => {
    const root = mkroot();
    writeLockfile(root, "secrets-guard"); // lockfile runtimes: ["claude"]
    writePayloadManifest(root, "secrets-guard", ["claude", "codex", "grok"]);
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true }); // detectRuntimes ⇒ this workspace runs grok
    const wv = fakeWebview();
    managerFor([target(root, "w1")]).bindControlEmbed(wv as never, "w1");
    // codex is declared but NOT run here → only grok is uncovered
    expect(uncoveredOf(wv, "secrets-guard")).toEqual(["grok"]);
  });

  it("stays silent when the payload manifest is absent — absence of evidence is not a gap", () => {
    const root = mkroot();
    writeLockfile(root, "secrets-guard");
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    // no .tachyon/plugins/secrets-guard/tachyon-plugin.json written
    const wv = fakeWebview();
    managerFor([target(root, "w1")]).bindControlEmbed(wv as never, "w1");
    expect(uncoveredOf(wv, "secrets-guard")).toBeUndefined();
  });

  it("stays silent when the payload manifest is corrupt (never guesses a runtime set)", () => {
    const root = mkroot();
    writeLockfile(root, "secrets-guard");
    fs.mkdirSync(path.join(root, ".tachyon/plugins/secrets-guard"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon/plugins/secrets-guard/tachyon-plugin.json"), "{ not json");
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    const wv = fakeWebview();
    managerFor([target(root, "w1")]).bindControlEmbed(wv as never, "w1");
    expect(uncoveredOf(wv, "secrets-guard")).toBeUndefined();
  });

  it("surfaces the gap WITHOUT an update-check having run (the silence breaks at rest)", () => {
    // the measured complaint was "Already up to date." with nothing else said. The gap is local-only
    // (lockfile + payload manifest + detectRuntimes), so it must not wait on "Check for updates".
    const root = mkroot();
    writeLockfile(root, "secrets-guard");
    writePayloadManifest(root, "secrets-guard", ["claude", "grok"]);
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    const wv = fakeWebview();
    managerFor([target(root, "w1")]).bindControlEmbed(wv as never, "w1");
    expect(statusOf(wv, "secrets-guard")).toBe("unknown"); // no check ran…
    expect(uncoveredOf(wv, "secrets-guard")).toEqual(["grok"]); // …and the gap is named anyway
  });
});
