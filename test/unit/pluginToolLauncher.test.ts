import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";
import { resolveToolForLaunch, launchTool, type ResolveOk } from "../../apps/vscode-extension/src/plugins/toolLauncher.js";

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const ECHO = ["/usr/bin/echo", "/bin/echo"].find((p) => fs.existsSync(p));
const ECHO_BYTES = ECHO ? fs.readFileSync(ECHO) : Buffer.from("not-elf");

function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tach-launch-"));
  const bin = path.join(ws, ".tachyon", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.chmodSync(path.join(ws, ".tachyon"), 0o700);
  fs.chmodSync(bin, 0o700);
  return ws;
}

function installFetched(ws: string, name: string, exeName: string, bytes: Buffer): { installPath: string; binSha256: string; abs: string } {
  const binSha = sha(bytes);
  const dir = path.join(ws, ".tachyon", "bin", name, binSha);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const abs = path.join(dir, exeName);
  fs.writeFileSync(abs, bytes, { mode: 0o500 });
  fs.chmodSync(abs, 0o500);
  return { installPath: `.tachyon/bin/${name}/${binSha}/${exeName}`, binSha256: binSha, abs };
}

function fetchedLock(name: string, exeName: string, binSha256: string, installPath: string) {
  return { name, source: "fetched", resolvedPlatform: "linux-x64-glibc", version: "1.0.0", binSha256, exeName, installPath, declaredUrl: "https://example.com/t", finalUrl: "https://example.com/t", artifactSha256: binSha256 };
}

function writeLock(ws: string, tools: unknown[]): void {
  const lf = { schemaVersion: 1, plugins: { cg: { name: "cg", version: "1.0.0", runtimes: [], targets: [], tools } } };
  fs.writeFileSync(path.join(ws, ".tachyon", "plugins.lock.json"), JSON.stringify(lf));
}

describe("resolveToolForLaunch", () => {
  let ws: string;
  beforeEach(() => (ws = makeWorkspace()));
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("resolves a valid fetched tool to an open, hash-verified fd", () => {
    const { installPath, binSha256 } = installFetched(ws, "gitleaks", "gitleaks", Buffer.from("BINARY"));
    writeLock(ws, [fetchedLock("gitleaks", "gitleaks", binSha256, installPath)]);
    const r = resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.execPath).toBe(path.join(ws, installPath));
      expect(r.binSha256).toBe(binSha256);
      fs.closeSync(r.fd);
    }
  });

  it("hard-fails when the lockfile is absent (REHYDRATE_REQUIRED)", () => {
    expect(resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws })).toMatchObject({ ok: false, code: "REHYDRATE_REQUIRED" });
  });

  it("fails closed when the tool is not in the lockfile (TOOL_NOT_FOUND)", () => {
    writeLock(ws, []);
    expect(resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws })).toMatchObject({ ok: false, code: "TOOL_NOT_FOUND" });
  });

  it("fails closed when the on-disk binary's bytes drift from the pin (HASH_MISMATCH)", () => {
    const { installPath, binSha256, abs } = installFetched(ws, "gitleaks", "gitleaks", Buffer.from("ORIGINAL"));
    writeLock(ws, [fetchedLock("gitleaks", "gitleaks", binSha256, installPath)]);
    fs.chmodSync(abs, 0o600);
    fs.writeFileSync(abs, "TAMPERED-DIFFERENT-BYTES"); // same path, new content
    fs.chmodSync(abs, 0o500);
    expect(resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws })).toMatchObject({ ok: false, code: "HASH_MISMATCH" });
  });

  it("fails closed when installPath doesn't match the content-address shape (BAD_INSTALL_PATH)", () => {
    const { binSha256 } = installFetched(ws, "gitleaks", "gitleaks", Buffer.from("BIN"));
    writeLock(ws, [fetchedLock("gitleaks", "gitleaks", binSha256, ".tachyon/bin/gitleaks/wrong/gitleaks")]);
    expect(resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws })).toMatchObject({ ok: false, code: "BAD_INSTALL_PATH" });
  });

  it("fails closed when .tachyon/bin is group/other-writable (UNTRUSTED_DIR)", () => {
    const { installPath, binSha256 } = installFetched(ws, "gitleaks", "gitleaks", Buffer.from("BIN"));
    writeLock(ws, [fetchedLock("gitleaks", "gitleaks", binSha256, installPath)]);
    fs.chmodSync(path.join(ws, ".tachyon", "bin"), 0o777);
    expect(resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws })).toMatchObject({ ok: false, code: "UNTRUSTED_DIR" });
  });

  it("fails closed when a fetched binary is hardlinked (NLINK)", () => {
    const { installPath, binSha256, abs } = installFetched(ws, "gitleaks", "gitleaks", Buffer.from("BIN"));
    fs.linkSync(abs, path.join(path.dirname(abs), "hardlink"));
    writeLock(ws, [fetchedLock("gitleaks", "gitleaks", binSha256, installPath)]);
    expect(resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws })).toMatchObject({ ok: false, code: "NLINK" });
  });

  it("is PLUGIN-SCOPED: a same tool name in two plugins resolves independently (no hijack)", () => {
    const a = installFetched(ws, "gitleaks", "gitleaks", Buffer.from("ONE"));
    const b = installFetched(ws, "gitleaks", "gitleaks", Buffer.from("TWO")); // same name dir, different sha subdir
    const lf = {
      schemaVersion: 1,
      plugins: {
        p1: { name: "p1", version: "1.0.0", runtimes: [], targets: [], tools: [fetchedLock("gitleaks", "gitleaks", a.binSha256, a.installPath)] },
        p2: { name: "p2", version: "1.0.0", runtimes: [], targets: [], tools: [fetchedLock("gitleaks", "gitleaks", b.binSha256, b.installPath)] },
      },
    };
    fs.writeFileSync(path.join(ws, ".tachyon", "plugins.lock.json"), JSON.stringify(lf));
    // p1's "gitleaks" and p2's "gitleaks" each resolve to their OWN binary — no global ambiguity.
    const r1 = resolveToolForLaunch("p1", "gitleaks", { workspaceRoot: ws });
    const r2 = resolveToolForLaunch("p2", "gitleaks", { workspaceRoot: ws });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) { expect(r1.binSha256).toBe(a.binSha256); fs.closeSync(r1.fd); }
    if (r2.ok) { expect(r2.binSha256).toBe(b.binSha256); fs.closeSync(r2.fd); }
  });

  it("fails closed for an unknown plugin (PLUGIN_NOT_FOUND)", () => {
    writeLock(ws, []);
    expect(resolveToolForLaunch("nope", "gitleaks", { workspaceRoot: ws })).toMatchObject({ ok: false, code: "PLUGIN_NOT_FOUND" });
  });

  it("validates a host-provided tool via injected ownership trust", () => {
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-host-"));
    const abs = path.join(hostDir, "gitleaks");
    fs.writeFileSync(abs, "HOSTBIN", { mode: 0o755 });
    fs.chmodSync(abs, 0o755);
    const binSha256 = sha(fs.readFileSync(abs));
    const host = { name: "gitleaks", source: "host-provided", resolvedPlatform: "linux-x64-glibc", version: "1.0.0", binSha256, exeName: "gitleaks", installPath: abs, hostDetected: { path: abs, version: "1.0.0", hash: binSha256 } };
    writeLock(ws, [host]);
    const uid = process.getuid?.() ?? 0;
    const r = resolveToolForLaunch("cg", "gitleaks", { workspaceRoot: ws, statPath: () => ({ uid, mode: 0o755, isFile: () => true }) });
    expect(r.ok).toBe(true);
    if (r.ok) fs.closeSync(r.fd);
    fs.rmSync(hostDir, { recursive: true, force: true });
  });
});

describe.skipIf(!ECHO)("launchTool (procfd exec)", () => {
  let ws: string;
  beforeEach(() => (ws = makeWorkspace()));
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("runs the validated native binary with passthrough args", () => {
    const { installPath, binSha256 } = installFetched(ws, "echo", "echo", ECHO_BYTES);
    writeLock(ws, [fetchedLock("echo", "echo", binSha256, installPath)]);
    const r = resolveToolForLaunch("cg", "echo", { workspaceRoot: ws }) as ResolveOk;
    expect(r.ok).toBe(true);
    const out = launchTool(r, ["HELLO-WORLD"], { captureOutput: true });
    fs.closeSync(r.fd);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/HELLO-WORLD/);
  });

  it("PROOF: execs the validated fd, not the path — a post-resolve path swap to a NEW inode is ignored", () => {
    const { installPath, binSha256, abs } = installFetched(ws, "echo", "echo", ECHO_BYTES);
    writeLock(ws, [fetchedLock("echo", "echo", binSha256, installPath)]);
    const r = resolveToolForLaunch("cg", "echo", { workspaceRoot: ws }) as ResolveOk;
    expect(r.ok).toBe(true);
    // swap the PATH to a different inode (unlink + recreate) AFTER the fd is held + hashed.
    fs.rmSync(abs);
    fs.writeFileSync(abs, "#!/bin/sh\necho SWAPPED\n", { mode: 0o755 });
    const out = launchTool(r, ["VALIDATED"], { captureOutput: true });
    fs.closeSync(r.fd);
    expect(out.stdout).toMatch(/VALIDATED/); // ran the original echo via the fd
    expect(out.stdout).not.toMatch(/SWAPPED/); // NOT the swapped-in path
  });
});

describe.skipIf(!ECHO)("launcher CLI end-to-end (bundled _tachyon-tool.js)", () => {
  let bundle: string;
  let ws: string;
  beforeAll(() => {
    bundle = path.join(os.tmpdir(), `tach-launcher-bundle-${process.pid}.cjs`);
    esbuild.buildSync({ entryPoints: ["apps/vscode-extension/src/toolLauncherEntry.ts"], bundle: true, outfile: bundle, platform: "node", format: "cjs", target: "node20", logLevel: "silent" });
  });
  afterAll(() => fs.rmSync(bundle, { force: true }));
  beforeEach(() => (ws = makeWorkspace()));
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("derives the workspace root from its own location and runs the tool", () => {
    fs.copyFileSync(bundle, path.join(ws, ".tachyon", "bin", "_tachyon-tool.js"));
    const { installPath, binSha256 } = installFetched(ws, "echo", "echo", ECHO_BYTES);
    writeLock(ws, [fetchedLock("echo", "echo", binSha256, installPath)]);
    const res = spawnSync("node", [path.join(ws, ".tachyon", "bin", "_tachyon-tool.js"), "cg", "echo", "E2E-OK"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/E2E-OK/);
  });

  it("exits non-zero (blocks the hook) on a missing lockfile", () => {
    fs.copyFileSync(bundle, path.join(ws, ".tachyon", "bin", "_tachyon-tool.js"));
    fs.rmSync(path.join(ws, ".tachyon", "plugins.lock.json"), { force: true });
    const res = spawnSync("node", [path.join(ws, ".tachyon", "bin", "_tachyon-tool.js"), "cg", "gitleaks"], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/REHYDRATE_REQUIRED/);
  });

  // spec 269 — a "tool" that prints a watched env var + its args, so we can prove the launcher's enforcement.
  const PROBE = Buffer.from('#!/bin/sh\necho "FORCED=$TACHYON_TEST_FORCED"\necho "ARGS=$*"\n');
  const launcherJs = (ws: string) => path.join(ws, ".tachyon", "bin", "_tachyon-tool.js");
  const lockWithPolicy = (binSha256: string, installPath: string, launchPolicy: unknown) => ({ ...fetchedLock("probe", "probe", binSha256, installPath), launchPolicy });

  it("spec 269 — injects the forced env + args, overriding a HOSTILE parent env", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE);
    writeLock(ws, [lockWithPolicy(binSha256, installPath, { env: { TACHYON_TEST_FORCED: "on" }, args: ["--forced"], mode: "force" })]);
    // the parent env tries to set the watched var to "off"; the policy must win.
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "agentArg"], { encoding: "utf8", env: { ...process.env, TACHYON_TEST_FORCED: "off" } });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/FORCED=on/);                 // policy env wins over the hostile parent "off"
    expect(res.stdout).toMatch(/ARGS=--forced agentArg/);    // forced arg prepended; the agent's arg kept
  });

  it("spec 269 — refuses a conflicting agent arg (POLICY_CONFLICT, fail closed)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE);
    writeLock(ws, [lockWithPolicy(binSha256, installPath, { env: { TACHYON_TEST_FORCED: "on" }, denyArgs: ["--confirm-actions"], mode: "force" })]);
    for (const conflict of [["--confirm-actions", ""], ["--confirm-actions=none"]]) {
      const res = spawnSync("node", [launcherJs(ws), "cg", "probe", ...conflict], { encoding: "utf8" });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/POLICY_CONFLICT/);
    }
  });

  it("spec 269 — a forced-arg flag cannot be neutralized by the agent re-passing it (codex #1)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE);
    // policy forces `--mode safe`; the agent must not be able to append `--mode danger` to win on a last-wins CLI.
    writeLock(ws, [lockWithPolicy(binSha256, installPath, { args: ["--mode", "safe"], mode: "force" })]);
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "--mode", "danger"], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/POLICY_CONFLICT/);
  });

  it("spec 269 — a tool with no policy is unaffected (plain passthrough, inherited env)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE);
    writeLock(ws, [fetchedLock("probe", "probe", binSha256, installPath)]);
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "plain"], { encoding: "utf8", env: { ...process.env, TACHYON_TEST_FORCED: "inherited" } });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/FORCED=inherited/); // no policy → parent env passes through
    expect(res.stdout).toMatch(/ARGS=plain/);
  });

  // spec 270/271 — a probe that prints a watched scrub var + its args.
  const PROBE2 = Buffer.from('#!/bin/sh\necho "SCRUB=$AB_SCRUB"\necho "ARGS=$*"\n');
  const PROBE2_INIT = Buffer.from('#!/bin/sh\necho "INIT=$AGENT_BROWSER_INIT_SCRIPTS"\necho "ARGS=$*"\n');
  const CFG_REL = ".tachyon/plugins/cg/config/ab.json";
  const writeLockCfg = (ws: string, tool: unknown) => {
    const lf = { schemaVersion: 1, plugins: { cg: { name: "cg", version: "1.0.0", runtimes: [], targets: [], tools: [tool], config: { file: CFG_REL } } } };
    fs.writeFileSync(path.join(ws, ".tachyon", "plugins.lock.json"), JSON.stringify(lf));
  };
  const writeCfgFile = (ws: string) => {
    fs.mkdirSync(path.join(ws, path.dirname(CFG_REL)), { recursive: true });
    fs.writeFileSync(path.join(ws, CFG_REL), "{}");
  };

  it("spec 270/271 — configArg feeds the plugin's human-owned config path (forced, prepended)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE2);
    writeLockCfg(ws, lockWithPolicy(binSha256, installPath, { configArg: "--config", denyArgs: ["--config"], mode: "force" }));
    writeCfgFile(ws);
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "snapshot"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain(`ARGS=--config ${path.join(ws, CFG_REL)} snapshot`);
  });

  it("spec 270/271 — the agent cannot pass its own config flag (POLICY_CONFLICT)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE2);
    writeLockCfg(ws, lockWithPolicy(binSha256, installPath, { configArg: "--config", denyArgs: ["--config"], mode: "force" }));
    writeCfgFile(ws);
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "--config", "/tmp/evil.json"], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/POLICY_CONFLICT/);
  });

  it("spec 271 — fails CLOSED when the human config is gone (CONFIG_MISSING, no ungated fallback)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE2);
    writeLockCfg(ws, lockWithPolicy(binSha256, installPath, { configArg: "--config", denyArgs: ["--config"], mode: "force" }));
    // NOTE: the config file is deliberately NOT created → the launcher must refuse, not run ungated.
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "snapshot"], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/CONFIG_MISSING/);
  });

  it("spec 271 — configArg with NO config recorded in the lockfile also fails CLOSED (codex dueto)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE2);
    // policy declares configArg, but the plugin lock has NO config block → must refuse, not run ungated.
    writeLock(ws, [lockWithPolicy(binSha256, installPath, { configArg: "--config", denyArgs: ["--config"], mode: "force" })]);
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "snapshot"], { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/CONFIG_MISSING/);
  });

  it("spec 271 — scrubEnv strips an agent-set override var from the child env", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE2);
    writeLock(ws, [lockWithPolicy(binSha256, installPath, { scrubEnv: ["AB_SCRUB"], mode: "force" })]);
    const res = spawnSync("node", [launcherJs(ws), "cg", "probe", "snapshot"], { encoding: "utf8", env: { ...process.env, AB_SCRUB: "agent-injected" } });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/SCRUB=\s*$/m); // stripped → empty value
  });

  // codex dueto — the init-script injection vector (a "read" `open` carrying attacker JS) must be closed BOTH ways:
  // the `--init-script` arg refused AND the AGENT_BROWSER_INIT_SCRIPTS env scrubbed (mirrors agent-browser's policy).
  it("spec 271 — init-script injection is closed (arg refused + env scrubbed)", () => {
    fs.copyFileSync(bundle, launcherJs(ws));
    const { installPath, binSha256 } = installFetched(ws, "probe", "probe", PROBE2_INIT);
    writeLock(ws, [lockWithPolicy(binSha256, installPath, { scrubEnv: ["AGENT_BROWSER_INIT_SCRIPTS"], denyArgs: ["--init-script"], mode: "force" })]);
    // (a) arg form refused even paired with a "read" open
    const argRes = spawnSync("node", [launcherJs(ws), "cg", "probe", "open", "--init-script", "/tmp/mutate.js"], { encoding: "utf8" });
    expect(argRes.status).not.toBe(0);
    expect(argRes.stderr).toMatch(/POLICY_CONFLICT/);
    // (b) env form stripped (a bare `open` can't carry an injected init script via env)
    const envRes = spawnSync("node", [launcherJs(ws), "cg", "probe", "open"], { encoding: "utf8", env: { ...process.env, AGENT_BROWSER_INIT_SCRIPTS: "/tmp/mutate.js" } });
    expect(envRes.status).toBe(0);
    expect(envRes.stdout).toMatch(/INIT=\s*$/m); // stripped → empty
  });
});
