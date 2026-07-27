import { defineConfig } from "@vscode/test-cli";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * t-d84837 — the editor-host suite runs against a COPY of its fixture, staged outside the Tachyon
 * worktrees base.
 *
 * Tachyon deliberately refuses to boot a full instance (Bridge + tmux engine + declared agents) for
 * a folder under the worktrees base: every managed worktree is a checkout of the repo and carries
 * its own `tachyon.yml`, so booting it would raise a phantom second instance
 * (`shouldActivateFolder`, t-2a73d6). That guard is correct and stays untouched.
 *
 * But when the REPO ITSELF is checked out under that base — which is what every agent worktree is —
 * the in-repo fixture inherits the exclusion. The extension activates, no workspace is ever created,
 * and every scenario needing a live workspace fails. Measured on clean `main` from a worktree:
 * 6 passing / 17 failing, with no `.tachyon/` written, no Bridge port bound, no engine unit started.
 * Nothing explains it in the logs, because the folder is simply filtered out before anything runs.
 *
 * Staging the fixture in the OS temp dir removes that coincidence without weakening the guard: the
 * suite exercises the same activation path a human's primary checkout gets, from anywhere. It also
 * stops the tests that mutate `tachyon.yml` from dirtying the committed fixture.
 */
const STAGING_ROOT = path.join(os.tmpdir(), "tachyon-vscode-test");

/**
 * The engine daemon is launched by `systemd-run` using a content-addressed COPY of the shell's
 * `process.execPath`. Inside the editor host that is the VS Code binary, and an Electron binary
 * copied away from its install directory cannot start: it dies with `error while loading shared
 * libraries: libffmpeg.so`, which systemd reports as `status=127`, so the engine never becomes
 * ready and activation fails with "persistent engine did not become ready in time".
 *
 * `TACHYON_DEV_HOST_ENGINE_RUNTIME` is the seam the Dev Host already uses for exactly this, honoured
 * on the `dev` channel that `npm run build` produces. Point it at the real Node running this config.
 */
const ENGINE_RUNTIME_ENV = { TACHYON_DEV_HOST_ENGINE_RUNTIME: process.execPath };

/**
 * t-05097f — the gate gets its OWN tmux server, per execution.
 *
 * It used to share the single default socket with the live fleet. Measured on this repo: the
 * "Stop All" scenario listed `tachyon-b349073a-*` — real agents belonging to running humans and
 * agents — and the suite's own `tachyon-a2e81f24-*` sessions outlived their run by hours. The next
 * run then found a declared entry already live, so `spawn` created nothing and emitted no
 * `new-session`, while the start summary still counted it as started. That is the whole reported
 * bug, and its intermittency: it only passed on a server that happened to be clean.
 *
 * A unique socket name plus a private, wiped TMUX_TMPDIR makes each run a distinct tmux server on a
 * distinct path. The suite cannot see, stop or inherit a session it did not create — not the
 * fleet's, and not its own from last time. This isolates the gate; it does not weaken it.
 */
const TMUX_TMPDIR = path.join(STAGING_ROOT, "tmux");
fs.rmSync(TMUX_TMPDIR, { recursive: true, force: true });
fs.mkdirSync(TMUX_TMPDIR, { recursive: true, mode: 0o700 });

const GATE_RUN_ID = `gate-${process.pid}-${Date.now().toString(36)}`;

const TMUX_ISOLATION_ENV = {
  TACHYON_TMUX_SOCKET: `tachyon-${GATE_RUN_ID}`,
  TMUX_TMPDIR,
  // t-05097f TEMPORARY — see recordEngineIdentityDiagnostic. Correlates every identity resolution
  // with the run that caused it; remove with the diagnostic once the question is answered.
  TACHYON_GATE_RUN_ID: GATE_RUN_ID,
  TACHYON_ENGINE_IDENTITY_DIAGNOSTIC: path.join(STAGING_ROOT, "engine-identity.jsonl"),
};

const GATE_ENV = { ...ENGINE_RUNTIME_ENV, ...TMUX_ISOLATION_ENV };

const SINGLE_ROOT_FIXTURE = stagedFixture("test/fixtures/sample-workspace");
const WORKSPACE_FOLDERS = [SINGLE_ROOT_FIXTURE];

/**
 * t-05097f — one-time migration of PRE-ISOLATION residue, for this run's staged workspace only.
 *
 * Before the engine identity carried the tmux isolation, a gate run booted a plain
 * `tachyon-engine-<legacyKey>.service` and left it behind. That unit carries `Restart=on-failure`,
 * so it resurrects on its own: measured at 16:28:06, recreating `tachyon-ctl-<wsHash>` on the SHARED
 * default socket one second later. An isolated run cannot displace it — it has a different identity
 * — so the residue has to be retired explicitly, once, or it keeps re-dirtying the default socket
 * and making consecutive runs disagree.
 *
 * Every name below is derived from THIS run's staged fixture path: the legacy key is the digest the
 * old code computed (workspace only, no override), and the sessions are the fixture's own wsHash.
 * No globbing, no other workspace root — a wildcard here could stop a real engine or kill a live
 * agent's pane, which is precisely the coupling this task exists to remove.
 */
function legacyEngineKey(workspaceRoot) {
  return createHash("sha256").update(fs.realpathSync(workspaceRoot)).digest("hex").slice(0, 32);
}

function fixtureWorkspaceHash(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 8);
}

function run(bin, argv, env = process.env) {
  try {
    execFileSync(bin, argv, { stdio: "ignore", env });
  } catch {
    /* absent is the goal state — best effort by design */
  }
}

function retirePreIsolationResidue() {
  for (const root of WORKSPACE_FOLDERS) {
    const legacyKey = legacyEngineKey(root);
    const unit = `tachyon-engine-${legacyKey}.service`;
    run("systemctl", ["--user", "stop", unit]);
    run("systemctl", ["--user", "reset-failed", unit]);

    const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
    if (runtimeDir) fs.rmSync(path.join(runtimeDir, "tachyon", "engines", legacyKey), { recursive: true, force: true });
    const stateHome = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state");
    fs.rmSync(path.join(stateHome, "tachyon", "engines", legacyKey), { recursive: true, force: true });

    // Sessions the residue left on the SHARED default socket — named for this fixture, one by one.
    const wsHash = fixtureWorkspaceHash(root);
    let names = [];
    try {
      names = execFileSync("tmux", ["-L", "tachyon", "list-sessions", "-F", "#{session_name}"], { encoding: "utf8" })
        .split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      names = []; // no default server running at all
    }
    for (const name of names) {
      if (name === `tachyon-ctl-${wsHash}` || name.startsWith(`tachyon-${wsHash}-`)) {
        run("tmux", ["-L", "tachyon", "kill-session", "-t", `=${name}`]);
      }
    }
  }
}

retirePreIsolationResidue();

/**
 * Teardown, scoped to THIS run's identity.
 *
 * `engineWorkspaceKey` folds the socket override into the engine's key, so this run owns a distinct
 * control socket, state dir and systemd unit. All of it must die with the run — a per-run engine
 * that outlived its run would be the same leak this task removes, only under a fresher name.
 *
 * The key is recomputed here with the same rule rather than imported, because this config file runs
 * before any build output exists. The shape is pinned by `engineIdentityIsolation` in the unit
 * tests, so a change to the rule fails there instead of silently orphaning units.
 */
function isolatedEngineKey(workspaceRoot) {
  const material = `${fs.realpathSync(workspaceRoot)}\u0000tmux:${TMUX_ISOLATION_ENV.TACHYON_TMUX_SOCKET}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function tearDownIsolatedGate() {
  const units = WORKSPACE_FOLDERS.map((root) => `tachyon-engine-${isolatedEngineKey(root)}.service`);
  for (const [bin, argv] of [
    ...units.map((unit) => ["systemctl", ["--user", "stop", unit]]),
    ["tmux", ["-L", TMUX_ISOLATION_ENV.TACHYON_TMUX_SOCKET, "kill-server"]],
  ]) {
    try {
      execFileSync(bin, argv, { stdio: "ignore", env: { ...process.env, ...TMUX_ISOLATION_ENV } });
    } catch {
      /* already gone — teardown is best-effort by design */
    }
  }
  fs.rmSync(TMUX_TMPDIR, { recursive: true, force: true });
}

process.on("exit", tearDownIsolatedGate);

function stagedFixture(relativePath) {
  const source = path.resolve(import.meta.dirname, relativePath);
  const staged = path.join(STAGING_ROOT, path.basename(source));
  // Fresh every run: a fixture a previous run edited must never leak into the next one.
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  fs.cpSync(source, staged, { recursive: true });
  return staged;
}

export default defineConfig([
  {
    label: "single-root",
    files: "test/integration/**/*.test.js",
    workspaceFolder: SINGLE_ROOT_FIXTURE,
    env: GATE_ENV,
    mocha: {
      ui: "bdd",
      timeout: 30000,
    },
  },
  {
    // Not staged: the multi-root fixture is a `.code-workspace` whose folder entries would need
    // rewriting to move. Left as-is rather than half-moved — tracked separately if it needs the
    // same treatment.
    label: "multi-root",
    files: "test/integration-multiroot/**/*.test.js",
    workspaceFolder: "test/fixtures/multiroot/multi.code-workspace",
    env: GATE_ENV,
    mocha: {
      ui: "bdd",
      timeout: 30000,
    },
  },
]);
