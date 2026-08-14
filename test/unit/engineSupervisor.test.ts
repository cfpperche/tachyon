import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import { EngineControlClient } from "@tachyon/engine/engine-service/controlClient.js";
import { bridgeTokenFileName } from "@tachyon/engine/bridge/token.js";
import { bridgeStateMigrationStorage } from "@tachyon/engine/bridge/stateMigrationStorage.js";
import {
  stageEngineBundle,
  stageEngineRuntime,
  type StagedEngineBundle,
  type StagedEngineRuntime,
} from "@tachyon/engine/engine-service/engineBundleStore.js";
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
} from "@tachyon/engine/engine-service/engineSupervisor.js";
import { DaemonStateStore, engineDaemonStateRoot } from "@tachyon/engine/engine-service/daemonStateStore.js";
import type { EngineStateMigrationV1 } from "@tachyon/engine/engine-service/stateMigration.js";
import { workspaceVersionStateKey } from "@tachyon/engine/workspace/operationalStateKeys.js";
import { ENGINE_SHELL_PROTOCOL, type EngineBundleManifestV1, type EngineServiceIdentityV1, type EngineShellHelloV1 } from "@tachyon/engine/engine-service/protocol.js";
import { TmuxService, workspaceHash } from "@tachyon/engine/tmux/TmuxService.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import { assertNoFleetLeak, isolatedDaemonChildEnv } from "../helpers/isolatedDaemonEnv.js";
import { bundledDaemonFixture } from "../helpers/daemonFixtureBundle.js";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

/**
 * Host isolation (t-13cc6e).  Every daemon this suite launches runs the real `startDaemonEngineService`,
 * whose first startup step is `GlobalTmuxWatchdog.start()`.  That watchdog is deliberately global rather
 * than per-workspace: it roots its lease at `$XDG_RUNTIME_DIR/tachyon/tmux-authority` and probes the
 * shared `-L tachyon` server under `$TMUX_TMPDIR`.  Inheriting the ambient values makes the suite contend
 * with the developer's own live engine — the probe of a busy real tmux server delays the daemon past the
 * supervisor's 750ms health budget, so `probeHealthyEngine` reports CONTROL_UNAVAILABLE instead of the
 * absent-engine ENOENT — and makes a unit test act as the host's tmux recovery authority (holding the
 * real watchdog leader lease, and SIGKILLing the host server if it ever probes as genuinely wedged).
 * Redirecting both variables for the whole file gives the suite, and every child it spawns, a private
 * runtime namespace; the engine socket paths were already private, this closes the remaining two.
 */
let hostIsolationRoot: string | undefined;
const ambientRuntimeEnv = new Map<string, string | undefined>();

beforeAll(() => {
  const root = makeSocketTemp("tes-isolation-");
  const runtime = path.join(root, "run");
  const tmuxTmp = path.join(root, "tmux");
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.mkdirSync(tmuxTmp, { mode: 0o700 });
  for (const key of ["XDG_RUNTIME_DIR", "TMUX_TMPDIR", "TMUX"]) {
    ambientRuntimeEnv.set(key, process.env[key]);
  }
  process.env.XDG_RUNTIME_DIR = runtime;
  process.env.TMUX_TMPDIR = tmuxTmp;
  // A nested $TMUX would make the daemon's tmux calls resolve the ambient server regardless of TMUX_TMPDIR.
  delete process.env.TMUX;
  hostIsolationRoot = root;
});

afterAll(() => {
  for (const [key, value] of ambientRuntimeEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ambientRuntimeEnv.clear();
  if (hostIsolationRoot) fs.rmSync(hostIsolationRoot, { recursive: true, force: true });
  hostIsolationRoot = undefined;
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent engine supervisor", () => {
  it("keeps a working engine until the human explicitly approves the destructive upgrade", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    let stops = 0;
    const launcher: EngineDaemonLauncher = async (input) => {
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async () => {
      stops += 1;
      const child = active;
      active = undefined;
      if (child) await stopChild(child);
    };
    const baseOptions = {
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    const original = await ensureDaemonEngine(baseOptions);
    const newer = stageTestBundle(fixture.root, "guard-v2", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.79.0", "stable");
    const prompts: unknown[] = [];

    const kept = await ensureDaemonEngine({
      ...baseOptions,
      bundle: newer,
      workingSnapshot: async () => ({ state: "known", agents: ["builder"] }),
      confirmUpgrade: async (snapshot) => {
        prompts.push(snapshot);
        return false;
      },
    });

    expect(prompts).toEqual([{ state: "known", agents: ["builder"] }]);
    expect(stops).toBe(0);
    expect(kept).toMatchObject({ identity: original.identity, disposition: "reused-compatible" });
    const newShell = new EngineControlClient({
      socketPath: fixture.socket,
      hello: hello(original.identity, "shell-after-decline"),
    });
    expect((await newShell.attach()).engine).toEqual(original.identity);
    await newShell.detach();
  });

  it("surfaces an unknown working snapshot instead of silently treating it as empty", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    const launcher: EngineDaemonLauncher = async (input) => {
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async () => {
      const child = active;
      active = undefined;
      if (child) await stopChild(child);
    };
    const baseOptions = {
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    await ensureDaemonEngine(baseOptions);
    const newer = stageTestBundle(fixture.root, "unknown-v2", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.79.0", "stable");
    const prompts: unknown[] = [];

    await ensureDaemonEngine({
      ...baseOptions,
      bundle: newer,
      workingSnapshot: async () => ({ state: "unknown" }),
      confirmUpgrade: async (snapshot) => {
        prompts.push(snapshot);
        return true;
      },
    });

    expect(prompts).toEqual([{ state: "unknown" }]);
  });

  it("keeps incompatible old-engine turns but explains that the new shell cannot attach", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    let stops = 0;
    const launcher: EngineDaemonLauncher = async (input) => {
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async () => {
      stops += 1;
      const child = active;
      active = undefined;
      if (child) await stopChild(child);
    };
    const baseOptions = {
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    await ensureDaemonEngine(baseOptions);
    const incompatible = stageTestBundle(
      fixture.root,
      "incompatible-guard-v2",
      { min: ENGINE_SHELL_PROTOCOL + 1, max: ENGINE_SHELL_PROTOCOL + 1 },
      "0.79.0",
      "stable",
    );

    await expect(ensureDaemonEngine({
      ...baseOptions,
      bundle: incompatible,
      workingSnapshot: async () => ({ state: "known", agents: ["builder"] }),
      confirmUpgrade: async () => false,
    })).rejects.toMatchObject({
      code: "ENGINE_UPGRADE_DECLINED",
      message: expect.stringMatching(/kept the current engine.*cannot connect/i),
    });
    expect(stops).toBe(0);
  });

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
      TACHYON_DEV_HOST: "1",
      TACHYON_DEV_HOST_PROFILE_HOME: path.join(root, "dev-host-profile-home"),
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
      "--setenv=TACHYON_DEV_HOST=1",
      `--setenv=TACHYON_DEV_HOST_PROFILE_HOME=${path.join(root, "dev-host-profile-home")}`,
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
    options.settings = { global: { "git.path": "/usr/bin/git" } };
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
      settings: { global: { "git.path": "x".repeat(70_000) } },
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
      runtime: fixture.runtime,
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
    expect(launchInputs[0].nodePath).toBe(fixture.runtime.executable);
    expect(launchInputs[0].nodePath).not.toBe(process.execPath);
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
      runtime: fixture.runtime,
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
      "stable",
    );

    const [first, second] = await Promise.all([
      ensureDaemonEngine({ ...baseOptions, bundle: newer }),
      ensureDaemonEngine({ ...baseOptions, bundle: newer }),
    ]);

    expect([first.disposition, second.disposition].sort()).toEqual(["reused-exact", "upgraded"]);
    expect(first.identity).toEqual(second.identity);
    expect(first.identity.bundleId).toBe(newer.bundleId);
    expect(first.identity.channel).toBe("stable");
    expect(first.identity.instanceId).not.toBe(original.identity.instanceId);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    const olderShell = await ensureDaemonEngine(baseOptions);
    expect(olderShell).toMatchObject({ disposition: "upgraded" });
    expect(olderShell.identity.bundleId).toBe(fixture.bundle.bundleId);
    expect(olderShell.identity.instanceId).not.toBe(first.identity.instanceId);
    expect(starts).toBe(3);
    expect(stops).toBe(2);
    const audit = fs.readFileSync(path.join(fixture.storage, "supervisor", "transitions.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.map((row) => row.phase)).toEqual(["prepared", "committed", "prepared", "committed"]);
    expect(audit[0]).toMatchObject({
      from: { instanceId: original.identity.instanceId, bundleId: fixture.bundle.bundleId },
      to: { bundleId: newer.bundleId, engineVersion: "0.58.0" },
    });
    expect(audit[1]).toMatchObject({
      from: { instanceId: original.identity.instanceId },
      to: { instanceId: first.identity.instanceId, bundleId: newer.bundleId },
    });
    expect(audit[2]).toMatchObject({
      phase: "prepared",
      from: { instanceId: first.identity.instanceId, bundleId: newer.bundleId },
      to: { bundleId: fixture.bundle.bundleId },
    });
    expect(audit[3]).toMatchObject({
      phase: "committed",
      from: { instanceId: first.identity.instanceId },
      to: { instanceId: olderShell.identity.instanceId, bundleId: fixture.bundle.bundleId },
    });
  }, 25_000);

  it("refuses stable same-version content drift and explicit stable/dev crossing", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    let starts = 0;
    let stops = 0;
    const launcher: EngineDaemonLauncher = async (input) => {
      starts += 1;
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async () => {
      stops += 1;
      if (!active) return;
      const child = active;
      active = undefined;
      await stopChild(child);
    };
    const stableA = stageTestBundle(
      fixture.root, "stable-a", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.58.0", "stable",
    );
    const stableB = stageTestBundle(
      fixture.root, "stable-b", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.58.0", "stable",
    );
    const dev = stageTestBundle(
      fixture.root, "dev-a", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.59.0", "dev",
    );
    const options = {
      workspaceRoot: fixture.workspace,
      bundle: stableA,
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    const original = await ensureDaemonEngine(options);
    expect(original.identity.channel).toBe("stable");
    await expect(ensureDaemonEngine({ ...options, bundle: stableB }))
      .rejects.toMatchObject({ code: "ENGINE_VERSION_CONTENT_CONFLICT" });
    await expect(ensureDaemonEngine({ ...options, bundle: dev }))
      .rejects.toMatchObject({ code: "ENGINE_CHANNEL_CONFLICT" });
    expect(starts).toBe(1);
    expect(stops).toBe(0);
  }, 20_000);

  it("adopts a same-version dev rebuild through the controlled transition", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    let starts = 0;
    let stops = 0;
    const launcher: EngineDaemonLauncher = async (input) => {
      starts += 1;
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async () => {
      stops += 1;
      if (!active) return;
      const child = active;
      active = undefined;
      await stopChild(child);
    };
    const devA = stageTestBundle(
      fixture.root, "dev-a", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.58.0", "dev",
    );
    const devB = stageTestBundle(
      fixture.root, "dev-b", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.58.0", "dev",
    );
    const options = {
      workspaceRoot: fixture.workspace,
      bundle: devA,
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    const original = await ensureDaemonEngine(options);
    const refreshed = await ensureDaemonEngine({ ...options, bundle: devB });
    expect(refreshed.disposition).toBe("upgraded");
    expect(refreshed.identity).toMatchObject({ bundleId: devB.bundleId, channel: "dev" });
    expect(refreshed.identity.instanceId).not.toBe(original.identity.instanceId);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
  }, 20_000);

  it("rolls a failed same-version dev rebuild back to the prior dev bundle", async () => {
    const fixture = workspaceFixture();
    let active: ChildProcessWithoutNullStreams | undefined;
    let refusedBundleId: string | undefined;
    const launcher: EngineDaemonLauncher = async (input) => {
      if (input.options.bundleId === refusedBundleId) throw new Error("injected dev rebuild failure");
      active = spawnWorker(input.encodedOptions);
      return "started";
    };
    const stopper: EngineDaemonStopper = async () => {
      if (!active) return;
      const child = active;
      active = undefined;
      await stopChild(child);
    };
    const devA = stageTestBundle(
      fixture.root, "dev-rollback-a", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.58.0", "dev",
    );
    const devB = stageTestBundle(
      fixture.root, "dev-rollback-b", { min: ENGINE_SHELL_PROTOCOL, max: ENGINE_SHELL_PROTOCOL }, "0.58.0", "dev",
    );
    const options = {
      workspaceRoot: fixture.workspace,
      bundle: devA,
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher,
      stopper,
      startTimeoutMs: 10_000,
      pollMs: 20,
    } as const;
    const original = await ensureDaemonEngine(options);
    refusedBundleId = devB.bundleId;
    await expect(ensureDaemonEngine({ ...options, bundle: devB }))
      .rejects.toMatchObject({ code: "ENGINE_UPGRADE_ROLLED_BACK" });
    const restored = await ensureDaemonEngine(options);
    expect(restored.identity).toMatchObject({ bundleId: devA.bundleId, channel: "dev" });
    expect(restored.identity.instanceId).not.toBe(original.identity.instanceId);
  }, 20_000);

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
      runtime: fixture.runtime,
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
      "stable",
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
      runtime: fixture.runtime,
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
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      migrationProvider: { storage: bridgeStateMigrationStorage, provide: async () => migration },
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

  // t-13cc6e — the loser shell probes the winner's endpoint between socket bind and first health
  // reply; under load that window outlives the 750ms control request, which used to hard-fail the
  // whole convergence on the first probe. The wait loops now treat CONTROL_UNAVAILABLE as transient
  // until the deadline, and only then re-raise it (never launching a duplicate meanwhile).
  it("keeps polling while a bound endpoint is not yet verifiable, then converges once it clears", async () => {
    const fixture = workspaceFixture();
    const held = new Set<net.Socket>();
    const hang = net.createServer((connection) => {
      held.add(connection);
      connection.on("error", () => {});
      connection.on("close", () => held.delete(connection));
    });
    await new Promise<void>((resolve, reject) => hang.listen(fixture.socket, resolve).once("error", reject));
    setTimeout(() => {
      for (const connection of held) connection.destroy();
      hang.close();
      fs.rmSync(fixture.socket, { force: true });
    }, 1_200).unref();
    let launches = 0;
    const result = await ensureDaemonEngine({
      workspaceRoot: fixture.workspace,
      bundle: fixture.bundle,
      runtime: fixture.runtime,
      storageRoot: fixture.storage,
      controlSocketPath: fixture.socket,
      launcher: async (input) => {
        launches += 1;
        spawnWorker(input.encodedOptions);
        return "started";
      },
      startTimeoutMs: 10_000,
      pollMs: 20,
    });
    expect(result.disposition).toBe("started");
    expect(launches).toBe(1);
  });

  it("still refuses a duplicate when the endpoint never becomes verifiable within the deadline", async () => {
    const fixture = workspaceFixture();
    const held = new Set<net.Socket>();
    const hang = net.createServer((connection) => {
      held.add(connection);
      connection.on("error", () => {});
      connection.on("close", () => held.delete(connection));
    });
    await new Promise<void>((resolve, reject) => hang.listen(fixture.socket, resolve).once("error", reject));
    let launches = 0;
    try {
      await expect(ensureDaemonEngine({
        workspaceRoot: fixture.workspace,
        bundle: fixture.bundle,
        runtime: fixture.runtime,
        storageRoot: fixture.storage,
        controlSocketPath: fixture.socket,
        launcher: async () => { launches += 1; return "started"; },
        startTimeoutMs: 1_600,
        pollMs: 20,
      })).rejects.toMatchObject({ code: "CONTROL_UNAVAILABLE" });
      expect(launches).toBe(0);
    } finally {
      for (const connection of held) connection.destroy();
      await new Promise<void>((resolve) => hang.close(() => resolve()));
    }
  });
});

function workspaceFixture(): {
  root: string;
  workspace: string;
  storage: string;
  socket: string;
  bundle: StagedEngineBundle;
  runtime: StagedEngineRuntime;
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
    runtime: stageTestRuntime(root),
  };
}

function stageTestRuntime(root: string): StagedEngineRuntime {
  const source = path.join(root, "runtime-source");
  fs.writeFileSync(source, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
  return stageEngineRuntime({ sourceExecutable: source, installRoot: path.join(root, "installed-runtimes") });
}

function stageTestBundle(
  root: string,
  name: string,
  protocol: EngineBundleManifestV1["protocol"],
  engineVersion = `0.57.0-${name}`,
  channel?: EngineBundleManifestV1["channel"],
): StagedEngineBundle {
  const source = path.join(root, `source-${name}`);
  const installRoot = path.join(root, "installed-bundles");
  const content = `// ${name}\n`;
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "engine-daemon.cjs"), content, "utf8");
  const manifest: EngineBundleManifestV1 = {
    schemaVersion: 1,
    ...(channel === undefined ? {} : { channel }),
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
  const worker = bundledDaemonFixture("engineSupervisorWorker.ts");
  // t-93ec7f: the daemon fixture is a new Tachyon machine. Host isolation (beforeAll) already
  // redirects XDG/TMUX on process.env; strip every ambient TACHYON_* so a live fleet token never
  // reaches the child, then reintroduce only the private tmux pointer the daemon needs.
  const childEnv = isolatedDaemonChildEnv(process.env, {
    ...(process.env.TMUX_TMPDIR
      ? { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TACHYON_ENGINE_TMUX_TMPDIR: process.env.TMUX_TMPDIR }
      : {}),
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
  });
  delete childEnv.TMUX;
  assertNoFleetLeak(childEnv);
  const child = spawn(process.execPath, [worker, encodedOptions], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });
  children.push(child);
  return child;
}

/**
 * t-95dedc — two budgets, because the single 5_000 they replace was covering two unrelated things.
 *
 * A duplicate daemon has to BOOT before it can refuse anything, and in-tree that boot is `vite-node`
 * transforming daemonMain's whole import graph. Measured on this host: 2.4s idle — of which `node`
 * itself is 22ms and the vite-node harness 167ms, so ~93% is the graph — 4.2s under 16 spinning
 * CPUs, and 7-8s inside the real 16-worker gate (read off the sibling tests here, which spawn 1-3 of
 * these workers each and cost 7.2s / 9.3s / 16.6s / 22.1s). So 5_000 was under the cost of the thing
 * it was waiting for whenever the suite was busy: measured at n=6 per tree, the whole gate went red
 * on this 2/6 at 3e5c8fd9 and 5/6 at fbd29ad1 — the same on both sides of t-9610e8, which is how we
 * know that change did not cause it. It has been below cost since 5c83dfc0 introduced it.
 *
 * PRODUCTION NEVER PAYS THAT BOOT: it launches the bundled engine-daemon.cjs with a staged runtime,
 * and the supervisor allows that start DEFAULT_START_TIMEOUT_MS = 10_000 — the same 10_000 this file
 * already passes as `startTimeoutMs`. The boot budget below is that number, for literally the same
 * boot, rather than a fresh one chosen to make today's red go away.
 *
 * t-d1f356 — and the paragraph above is now HISTORY: `spawnWorker` no longer launches vite-node. The
 * fixture is bundled once per round (test/globalSetup/daemonFixtureBundles.ts) and spawned as plain
 * `node`, which is what production does, so a child boots in ~0.2s instead of ~2s and this file fell
 * from 41.4s to 9.9s. THE BUDGET DOES NOT MOVE, and not out of caution: 10_000 was derived from
 * production's DEFAULT_START_TIMEOUT_MS rather than from the harness cost that just disappeared, so
 * nothing it was measuring changed. Buying a second back in a wait is how contention becomes flake.
 *
 * What the test actually asserts is the refusal and the EXIT, so that keeps a tight budget of its
 * own, counted from the moment the child first speaks. The failure worth catching here is a leaked
 * handle, which hangs forever and still trips it. And whichever budget lapses now NAMES itself: the
 * old message read `child exit timed out:` with an empty stderr whether the child had died mid-boot
 * or refused correctly and then hung — opposite defects, one indistinguishable message.
 */
const CHILD_BOOT_BUDGET_MS = 10_000;
const CHILD_EXIT_BUDGET_MS = 2_000;

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`${reason}; stderr so far: ${JSON.stringify(stderr)}`));
    };
    let timer = setTimeout(
      () => fail(`child wrote nothing within the ${CHILD_BOOT_BUDGET_MS}ms boot budget — still starting up`),
      CHILD_BOOT_BUDGET_MS,
    );
    child.stderr.on("data", (chunk: Buffer) => {
      const firstOutput = stderr.length === 0;
      stderr += chunk.toString("utf8");
      if (!firstOutput) return;
      // It has reached its own error path, so the boot is no longer what is being measured.
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(`child refused but did not exit within ${CHILD_EXIT_BUDGET_MS}ms — leaked handle`),
        CHILD_EXIT_BUDGET_MS,
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
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
  const root = makeSocketTemp(prefix);
  roots.push(root);
  return root;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function base64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
