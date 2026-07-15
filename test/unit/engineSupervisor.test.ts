import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EngineControlClient } from "../../src/engine-service/controlClient.js";
import { bridgeTokenFileName } from "../../src/bridge/token.js";
import { stageEngineBundle, type StagedEngineBundle } from "../../src/engine-service/engineBundleStore.js";
import {
  buildEngineSystemdRunArgs,
  decodeEngineDaemonOptions,
  encodeEngineDaemonOptions,
  engineControlSocketPath,
  engineRuntimeDir,
  engineStorageRoot,
  engineSystemdUnitName,
  engineWorkspaceKey,
  ensureDaemonEngine,
  ensureSecureEngineRuntimeDir,
  type EngineDaemonLaunchInput,
  type EngineDaemonLauncher,
  type EngineDaemonOptionsV1,
  type EngineDaemonStopper,
} from "../../src/engine-service/engineSupervisor.js";
import { DaemonStateStore, engineDaemonStateRoot } from "../../src/engine-service/daemonStateStore.js";
import type { EngineStateMigrationV1 } from "../../src/engine-service/stateMigration.js";
import { workspaceVersionStateKey } from "../../src/workspace/operationalStateKeys.js";
import { ENGINE_SHELL_PROTOCOL, type EngineBundleManifestV1, type EngineServiceIdentityV1, type EngineShellHelloV1 } from "../../src/engine-service/protocol.js";
import { TmuxService, workspaceHash } from "../../src/tmux/TmuxService.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent engine supervisor", () => {
  it("derives one canonical private identity and an allowlisted systemd launch", () => {
    // Keep the synthetic XDG path realistic: AF_UNIX has a deliberately enforced 100-byte budget.
    const root = temp("tes-path-");
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(runtime, { mode: 0o700 });
    fs.symlinkSync(workspace, alias);
    const env: NodeJS.ProcessEnv = {
      XDG_RUNTIME_DIR: runtime,
      XDG_STATE_HOME: path.join(root, "state-home"),
      HOME: path.join(root, "home"),
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      OPENAI_API_KEY: "must-not-cross-the-launch-boundary",
    };

    expect(engineWorkspaceKey(alias)).toBe(engineWorkspaceKey(workspace));
    expect(engineSystemdUnitName(alias)).toBe(engineSystemdUnitName(workspace));
    expect(engineSystemdUnitName(workspace)).toMatch(/^tachyon-engine-[a-f0-9]{32}\.service$/);
    expect(engineRuntimeDir(workspace, env)).toBe(path.join(runtime, "tachyon", "engines", engineWorkspaceKey(workspace)));
    expect(engineControlSocketPath(workspace, env)).toBe(path.join(engineRuntimeDir(workspace, env), "control.sock"));
    expect(engineStorageRoot(workspace, "linux", env, env.HOME)).toBe(
      path.join(env.XDG_STATE_HOME!, "tachyon", "engines", engineWorkspaceKey(workspace)),
    );

    const options = daemonOptions(workspace, path.join(root, "state"), path.join(root, "bundle"), path.join(runtime, "engine.sock"));
    const input: EngineDaemonLaunchInput = {
      options,
      daemonModule: "/immutable/engine-daemon.cjs",
      encodedOptions: encodeEngineDaemonOptions(options),
      unitName: engineSystemdUnitName(workspace),
      nodePath: "/usr/bin/node",
    };
    const args = buildEngineSystemdRunArgs(input, env);
    expect(args).toEqual(expect.arrayContaining([
      "--user",
      "--collect",
      `--unit=${input.unitName}`,
      "--property=Restart=on-failure",
      "--property=KillMode=control-group",
      "--property=UMask=0077",
      "--setenv=ELECTRON_RUN_AS_NODE=1",
      "--setenv=TACHYON_ENGINE_SERVICE=1",
      "--setenv=PATH=/usr/bin:/bin",
    ]));
    expect(args.slice(-4)).toEqual(["--", input.nodePath, input.daemonModule, input.encodedOptions]);
    expect(args.join("\n")).not.toContain("OPENAI_API_KEY");
    expect(args.join("\n")).not.toContain("must-not-cross-the-launch-boundary");
  });

  it("strictly decodes only the versioned allowlisted daemon launch envelope", () => {
    const root = temp("tachyon-engine-supervisor-codec-");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { mode: 0o700 });
    const options = daemonOptions(workspace, path.join(root, "state"), path.join(root, "bundle"), path.join(root, "engine.sock"));
    options.settings = { global: { "tachyon.maxAgents": 4 } };
    expect(decodeEngineDaemonOptions(encodeEngineDaemonOptions(options))).toEqual(options);

    expect(() => decodeEngineDaemonOptions(base64({ ...options, unexpected: true })))
      .toThrowError(expect.objectContaining({ code: "INVALID_DAEMON_OPTIONS" }));
    expect(() => decodeEngineDaemonOptions(base64({ ...options, settings: [] })))
      .toThrowError(expect.objectContaining({ code: "INVALID_DAEMON_OPTIONS" }));
    expect(() => decodeEngineDaemonOptions(base64({ ...options, settings: { global: { secret: "no" } } })))
      .toThrowError(expect.objectContaining({ code: "INVALID_DAEMON_OPTIONS" }));
    expect(() => decodeEngineDaemonOptions("not-json"))
      .toThrowError(expect.objectContaining({ code: "INVALID_DAEMON_OPTIONS" }));
    expect(() => encodeEngineDaemonOptions({
      ...options,
      settings: { global: { "tachyon.maxAgents": "x".repeat(70_000) } },
    })).toThrowError(expect.objectContaining({ code: "DAEMON_OPTIONS_TOO_LARGE" }));
  });

  it("rejects an attacker-controlled intermediate runtime symlink", () => {
    const root = temp("tachyon-engine-supervisor-runtime-");
    const workspace = path.join(root, "workspace");
    const runtime = path.join(root, "runtime");
    const tachyon = path.join(runtime, "tachyon");
    const redirect = path.join(root, "redirect");
    fs.mkdirSync(workspace, { mode: 0o700 });
    fs.mkdirSync(tachyon, { recursive: true, mode: 0o700 });
    fs.mkdirSync(redirect, { mode: 0o700 });
    fs.symlinkSync(redirect, path.join(tachyon, "engines"));

    expect(() => ensureSecureEngineRuntimeDir(workspace, { XDG_RUNTIME_DIR: runtime }))
      .toThrowError(/unsafe|not a real directory/i);
  });

  it("makes concurrent shells converge on one real Workspace and one Bridge", async () => {
    const fixture = workspaceFixture();
    let launchCalls = 0;
    let launched: ChildProcessWithoutNullStreams | undefined;
    let releaseFirst!: () => void;
    const secondArrived = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const launchInputs: EngineDaemonLaunchInput[] = [];
    const launcher: EngineDaemonLauncher = async (input) => {
      launchInputs.push(input);
      launchCalls += 1;
      if (launchCalls === 1) {
        // Force both supervisors through the absent-engine probe before the winner starts.
        await secondArrived;
        launched = spawnWorker(input.encodedOptions);
        return "started";
      }
      releaseFirst();
      return "contended";
    };
    const ensureOptions = {
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;

    const [first, second] = await Promise.all([
      ensureDaemonEngine(ensureOptions),
      ensureDaemonEngine(ensureOptions),
    ]);
    expect(launchCalls).toBe(2);
    expect(launchInputs[0]).toEqual(launchInputs[1]);
    expect([first.disposition, second.disposition].sort()).toEqual(["contended", "started"]);
    expect(first.identity).toEqual(second.identity);
    expect(first.identity.pid).toBe(launched!.pid);
    expect(first.identity.bundleId).toBe(fixture.bundle.bundleId);
    expect(first.identity.bridge).toMatchObject({ instanceId: expect.any(String), port: expect.any(Number) });

    const oldShell = new EngineControlClient({ socketPath: fixture.socket, hello: hello(first.identity, "shell-old") });
    const newShell = new EngineControlClient({ socketPath: fixture.socket, hello: hello(first.identity, "shell-new") });
    expect((await oldShell.attach()).engine).toEqual((await newShell.attach()).engine);
    expect((await newShell.health()).shellCount).toBe(2);

    const reused = await ensureDaemonEngine({
      ...ensureOptions,
      launcher: async () => { throw new Error("exact reuse must not launch"); },
    });
    expect(reused).toMatchObject({ identity: first.identity, disposition: "reused-exact" });

    const compatible = stageTestBundle(fixture.root, "compatible-v2", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL });
    const compatibleReuse = await ensureDaemonEngine({
      ...ensureOptions,
      bundle: compatible,
      launcher: async () => { throw new Error("compatible reuse must not launch"); },
    });
    expect(compatibleReuse).toMatchObject({ identity: first.identity, disposition: "reused-compatible" });

    const incompatible = stageTestBundle(fixture.root, "incompatible-v2", { min: ENGINE_SHELL_PROTOCOL + 1, max: ENGINE_SHELL_PROTOCOL + 1 });
    await expect(ensureDaemonEngine({ ...ensureOptions, bundle: incompatible }))
      .rejects.toMatchObject({ code: "INCOMPATIBLE_ENGINE" });

    const tampered = stageTestBundle(fixture.root, "tampered", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL });
    fs.chmodSync(tampered.entrypoint, 0o600);
    fs.writeFileSync(tampered.entrypoint, "tampered after staging", "utf8");
    await expect(ensureDaemonEngine({ ...ensureOptions, bundle: tampered }))
      .rejects.toMatchObject({ code: "BUNDLE_VERIFICATION_FAILED" });

    // Even a manually duplicated daemon refuses a live socket without unlinking the real owner's endpoint.
    const duplicate = spawnWorker(launchInputs[0]!.encodedOptions);
    const duplicateResult = await waitForClose(duplicate);
    expect(duplicateResult.code).toBe(1);
    expect(duplicateResult.stderr).toContain("already has a live owner");
    expect((await oldShell.health()).engine).toEqual(first.identity);

    await oldShell.detach();
    await newShell.detach();
    await stopChild(launched!);
    expect(fs.existsSync(fixture.socket)).toBe(false);
    expect(await new TmuxService().hasSession(`tachyon-ctl-${first.identity.workspaceHash}`)).toBe(false);
  }, 25_000);

  it("serializes concurrent newer-bundle activation and records the exact old/new incarnations", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    let starts = 0;
    let stops = 0;
    const launcher: EngineDaemonLauncher = async (input) => {
      starts += 1;
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async (input) => {
      if (input.expectedIdentity && active?.pid !== input.expectedIdentity.pid) {
        throw new Error("stopper identity mismatch");
      }
      if (!active) return;
      stops += 1;
      const child = active;
      active = undefined;
      await stopChild(child);
    };
    const baseOptions = {
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    const original = await ensureDaemonEngine(baseOptions);
    const newer = stageTestBundle(
      fixture.root,
      "engine-v2",
      { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
      "0.58.0",
    );

    const [first, second] = await Promise.all([
      ensureDaemonEngine({ ...baseOptions, bundle: newer }),
      ensureDaemonEngine({ ...baseOptions, bundle: newer }),
    ]);

    expect([first.disposition, second.disposition].sort()).toEqual(["reused-exact", "upgraded"]);
    expect(first.identity).toEqual(second.identity);
    expect(first.identity.bundleId).toBe(newer.bundleId);
    expect(first.identity.instanceId).not.toBe(original.identity.instanceId);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    const olderShell = await ensureDaemonEngine(baseOptions);
    expect(olderShell).toMatchObject({ identity: first.identity, disposition: "reused-compatible" });
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    const audit = fs.readFileSync(path.join(fixture.storage, "supervisor", "transitions.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.map((row) => row.phase)).toEqual(["prepared", "committed"]);
    expect(audit[0]).toMatchObject({
      from: { instanceId: original.identity.instanceId, bundleId: fixture.bundle.bundleId },
      to: { bundleId: newer.bundleId, engineVersion: "0.58.0" },
    });
    expect(audit[1]).toMatchObject({
      from: { instanceId: original.identity.instanceId },
      to: { instanceId: first.identity.instanceId, bundleId: newer.bundleId },
    });
  }, 25_000);

  it("restores the verified prior bundle when the newer engine cannot launch", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    let refusedBundleId: string | undefined;
    const launcher: EngineDaemonLauncher = async (input) => {
      if (input.options.bundleId === refusedBundleId) throw new Error("injected new-engine launch failure");
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async (input) => {
      if (input.expectedIdentity && active?.pid !== input.expectedIdentity.pid) {
        throw new Error("stopper identity mismatch");
      }
      if (!active) return;
      const child = active;
      active = undefined;
      await stopChild(child);
    };
    const baseOptions = {
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    const original = await ensureDaemonEngine(baseOptions);
    const broken = stageTestBundle(
      fixture.root,
      "engine-broken-v2",
      { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
      "0.58.0",
    );
    refusedBundleId = broken.bundleId;

    await expect(ensureDaemonEngine({ ...baseOptions, bundle: broken }))
      .rejects.toMatchObject({ code: "ENGINE_UPGRADE_ROLLED_BACK" });

    const restored = await ensureDaemonEngine({
      ...baseOptions,
      launcher: async () => { throw new Error("restored engine must be reused"); },
    });
    expect(restored.disposition).toBe("reused-exact");
    expect(restored.identity.bundleId).toBe(fixture.bundle.bundleId);
    expect(restored.identity.instanceId).not.toBe(original.identity.instanceId);
    const audit = fs.readFileSync(path.join(fixture.storage, "supervisor", "transitions.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.map((row) => row.phase)).toEqual(["prepared", "rolled-back"]);
    expect(audit[1]).toMatchObject({
      attemptedBundleId: broken.bundleId,
      restored: { bundleId: fixture.bundle.bundleId, instanceId: restored.identity.instanceId },
    });
  }, 25_000);

  it("refuses a non-socket control entry before invoking the launcher", async () => {
    const fixture = workspaceFixture();
    fs.writeFileSync(fixture.socket, "do not replace", { mode: 0o600 });
    let launches = 0;
    await expect(ensureDaemonEngine({
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher: async () => { launches += 1; return "started"; },
    })).rejects.toMatchObject({ code: "CONTROL_PATH_UNSAFE" });
    expect(launches).toBe(0);
    expect(fs.readFileSync(fixture.socket, "utf8")).toBe("do not replace");
  });

  it("imports shell-authored legacy state before launch without putting it in daemon argv", async () => {
    const fixture = workspaceFixture();
    const hash = workspaceHash(fs.realpathSync(fixture.workspace));
    const migration: EngineStateMigrationV1 = {
      schemaVersion: 1,
      workspaceHash: hash,
      state: { lastVersion: "0.56.4" },
      secrets: { callerIdentityHmacKey: "a".repeat(64) },
      tokens: { bridge: "b".repeat(64) },
    };
    await expect(ensureDaemonEngine({
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      migrationProvider: async () => migration,
      launcher: async (input) => {
        const daemonStateRoot = engineDaemonStateRoot(fixture.storage);
        expect(new DaemonStateStore(daemonStateRoot).getState(workspaceVersionStateKey(hash))).toBe("0.56.4");
        expect(fs.readFileSync(path.join(daemonStateRoot, bridgeTokenFileName(hash)), "utf8").trim()).toBe("b".repeat(64));
        expect(fs.existsSync(path.join(fixture.storage, "state.json"))).toBe(false);
        expect(fs.existsSync(path.join(fixture.storage, bridgeTokenFileName(hash)))).toBe(false);
        expect(decodeEngineDaemonOptions(input.encodedOptions)).not.toHaveProperty("migration");
        throw new Error("launch observed");
      },
    })).rejects.toThrow("launch observed");
  });
});

function workspaceFixture(): {
  root: string;
  workspace: string;
  storage: string;
  socket: string;
  bundle: StagedEngineBundle;
} {
  const root = temp("tachyon-engine-supervisor-live-");
  const workspace = path.join(root, "workspace");
  const storage = path.join(root, "state");
  const runtime = path.join(root, "runtime");
  for (const directory of [workspace, storage, runtime]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, "tachyon.yml"), [
    "agents:",
    "  worker:",
    "    cmd: sh",
    "    autostart: false",
    "",
  ].join("\n"), "utf8");
  return {
    root,
    workspace,
    storage,
    socket: path.join(runtime, "control.sock"),
    bundle: stageTestBundle(root, "engine-v1", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }),
  };
}

function stageTestBundle(
  root: string,
  name: string,
  protocol: EngineBundleManifestV1["protocol"],
  engineVersion = `0.57.0-${name}`,
): StagedEngineBundle {
  const source = path.join(root, `source-${name}`);
  const installRoot = path.join(root, "installed-bundles");
  const content = `// ${name}\n`;
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "engine-daemon.cjs"), content, "utf8");
  const manifest: EngineBundleManifestV1 = {
    schemaVersion: 1,
    engineVersion,
    protocol,
    entrypoint: "engine-daemon.cjs",
    files: [{ path: "engine-daemon.cjs", sha256: sha256(content), executable: true }],
    build: { commit: "a".repeat(40), treeSha: "b".repeat(40), workingTreeClean: true },
  };
  return stageEngineBundle({ sourceRoot: source, manifest, installRoot });
}

function daemonOptions(
  workspaceRoot: string,
  storageRoot: string,
  mediaRoot: string,
  controlSocketPath: string,
): EngineDaemonOptionsV1 {
  return {
    schemaVersion: 1,
    workspaceRoot: fs.realpathSync(workspaceRoot),
    storageRoot,
    mediaRoot,
    controlSocketPath,
    appVersion: "0.57.0-test",
    bundleId: "a".repeat(64),
  };
}

function hello(identity: EngineServiceIdentityV1, shellId: string): EngineShellHelloV1 {
  return {
    schemaVersion: 1,
    op: "attach",
    workspaceRoot: identity.workspaceRoot,
    workspaceHash: identity.workspaceHash,
    shell: { id: shellId, version: "0.57.0-test", locale: "en" },
    protocol: { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL },
    capabilities: [],
    settingsDigest: sha256("settings"),
  };
}

function spawnWorker(encodedOptions: string): ChildProcessWithoutNullStreams {
  const viteNode = path.join(process.cwd(), "node_modules/vite-node/vite-node.mjs");
  const worker = path.join(process.cwd(), "test/fixtures/engineSupervisorWorker.ts");
  const child = spawn(process.execPath, [viteNode, worker, encodedOptions], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child exit timed out: ${stderr}`));
    }, 5_000);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
