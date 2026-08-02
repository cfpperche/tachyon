/**
 * t-09edf2 — secrets-guard layer 2 in an agent's own session, one test per ACTOR × TRIGGER.
 *
 * The names below are the rows of the task's reach table, spelled the same way, because
 * `docs/project-guidance.md` asks for exactly that: the actor × trigger list becomes the test list, so
 * a door that appears later either joins it or is visibly uncovered. `t-e73e54` exists because someone
 * treated create/restart/resume/fork as one case; here each is invoked separately even where they share
 * a materializer, and each asserts the gate survives the options THAT door passes.
 *
 * These tests EXECUTE the projected hook command with a real `PreToolUse` payload and assert the exit
 * code the runtime acts on. A test that only read the generated settings file would prove the file was
 * written, which is precisely what was already true on 2026-08-01 while `git commit --no-verify` sailed
 * through to Git and exited 129 on an unknown option.
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import TOML from "@iarna/toml";
import { HarnessManager, bridgeGrokHome, harnessHome } from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";
import { spawnSettingsPath, type OwnershipHookGroup } from "../../src/activity/sessionOwners.js";
import {
  planProjectedPluginHooks,
  readHookProjectionCandidates,
  type AgentHookProjectionPolicy,
  type HookProjectionCandidate,
} from "../../src/plugins/agentHookProjection.js";
import { makeTempDir } from "../helpers/tempDir.js";

/**
 * A stand-in for the plugin's `guard.sh`, implementing the layer-2 contract the task states: refuse the
 * shapes that skip the `pre-commit` gate (`--no-verify` / `-n`, `git commit -a`, `add … && commit`) with
 * exit 2 BEFORE Git runs, and let an ordinary commit through to layer 1 with exit 0.
 *
 * Deliberately not the installed plugin's own script: the test must run on a machine where no plugin is
 * installed. What Tachyon owns — and what regressed — is the CHANNEL, so the channel is what is proven
 * end to end, with a gate that behaves like the real one on both verdicts.
 */
const GUARD_SOURCE = `// layer-2 shape gate (test fixture) — mirrors secrets-guard's PreToolUse contract.
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let command = "";
  try { command = JSON.parse(raw || "{}")?.tool_input?.command ?? ""; } catch { command = ""; }
  const commits = /(^|[;&|]\\s*)git\\s+(?:-[^\\s]+\\s+)*commit\\b/.test(command);
  if (commits) {
    if (/\\s(?:--no-verify|-n)(?=\\s|$)/.test(command)) {
      process.stderr.write("--no-verify skips the gitleaks pre-commit gate\\n");
      process.exit(2);
    }
    if (/git\\s+commit\\s+(?:[^\\s]*\\s+)*?-[A-Za-z]*a/.test(command)) {
      process.stderr.write("git commit -a stages outside the scanned index\\n");
      process.exit(2);
    }
    if (/(?:^|[;&|])\\s*git\\s+add\\b[\\s\\S]*[;&|]+\\s*git\\s+(?:-[^\\s]+\\s+)*commit\\b/.test(command)) {
      process.stderr.write("compound stage+commit hides the staged set from review\\n");
      process.exit(2);
    }
  }
  process.exit(0);
});
`;

/** The `PreToolUse(Bash)` payload shape both runtimes hand a hook on stdin. */
function payload(command: string): string {
  return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
}

interface Fixture {
  /** The AUTHORITY checkout: where the human installed the plugin and where the lockfile lives. */
  authority: string;
  /** The DELEGATED worktree: the agent's real cwd, with no `.claude` / `.codex` tree of its own. */
  worktree: string;
}

let fixture: Fixture;

function guardCommand(authority: string, runtime: "claude" | "codex"): string {
  const script = path.join(authority, ".tachyon", "plugins", "secrets-guard", runtime, "guard.cjs");
  // Shaped like the installed plugin's real command: fail CLOSED when the payload root is missing, so a
  // partially removed plugin blocks rather than silently waving the bypass through.
  return `if [ ! -f '${script}' ]; then echo '[tachyon] plugin hook root missing' >&2; exit 2; fi; node '${script}'`;
}

function lockfileWith(authority: string, runtimes: readonly ("claude" | "codex")[]): void {
  const targets = runtimes.map((runtime) => ({
    runtime,
    kind: "settings-hook",
    file: runtime === "claude" ? ".claude/settings.json" : ".codex/hooks.json",
    ref: "PreToolUse",
    removal: [{
      matcher: runtime === "claude" ? "Bash" : "^Bash$",
      hooks: [{
        type: "command",
        command: guardCommand(authority, runtime),
        ...(runtime === "codex" ? { statusMessage: "secrets-guard shape-gate" } : {}),
      }],
    }],
  }));
  const lock = {
    schemaVersion: 1,
    plugins: {
      // A skills-only plugin, present so the policy's selectivity is exercised rather than assumed.
      sdd: {
        name: "sdd",
        version: "1.7.1",
        runtimes: ["claude", "codex"],
        targets: [{ runtime: "claude", kind: "skill-dir", file: ".claude/skills/sdd" }],
      },
      "secrets-guard": { name: "secrets-guard", version: "2.0.4", runtimes: [...runtimes], targets },
    },
  };
  fs.mkdirSync(path.join(authority, ".tachyon"), { recursive: true });
  fs.writeFileSync(path.join(authority, ".tachyon", "plugins.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

const POLICY: AgentHookProjectionPolicy = { "secrets-guard": "enforcement" };

beforeAll(() => {
  const authority = makeTempDir("tachyon-guard-authority-");
  const worktree = makeTempDir("tachyon-guard-worktree-");
  for (const runtime of ["claude", "codex"] as const) {
    const dir = path.join(authority, ".tachyon", "plugins", "secrets-guard", runtime);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "guard.cjs"), GUARD_SOURCE);
  }
  lockfileWith(authority, ["claude", "codex"]);

  // The installed plugin's own artifacts, in the checkout the human installed into. A delegated
  // worktree has NEITHER of these, which is the whole defect.
  fs.mkdirSync(path.join(authority, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(authority, ".claude", "settings.json"), `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`);
  fs.mkdirSync(path.join(authority, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(authority, ".codex", "hooks.json"), `${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`);

  fixture = { authority, worktree };
});

/** Run one projected hook command exactly as a runtime would: `sh -c`, payload on stdin, agent's cwd. */
function runGate(command: string, bash: string): { status: number; stderr: string } {
  const result = spawnSync("sh", ["-c", command], {
    input: payload(bash),
    cwd: fixture.worktree,
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function planFor(runtime: string, options: { authority?: string; policy?: AgentHookProjectionPolicy } = {}) {
  return planProjectedPluginHooks({
    plugins: readHookProjectionCandidates(options.authority ?? fixture.authority),
    runtime,
    policy: options.policy ?? POLICY,
  });
}

/** The Claude launch channel: the per-spawn `--settings` file, produced by the real materializer. */
function claudeSessionGate(door: { ownershipOnly: boolean }): OwnershipHookGroup[] {
  const harness = new HarnessManager(fixture.authority);
  const plan = planFor("claude");
  const file = harness.materializeOwnershipSettings(
    "delegado",
    door.ownershipOnly ? undefined : path.join(fixture.authority, ".tachyon", "HANDOFF.md"),
    { silentPersistence: !door.ownershipOnly, projectedHooks: plan.hooks },
  );
  expect(file).toBe(spawnSettingsPath(fixture.authority, "delegado"));
  const settings = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, OwnershipHookGroup[]> };
  // The lifecycle channel must survive intact: a gate that displaced SessionStart would turn Activity
  // off to install a guard.
  expect(settings.hooks.SessionStart?.length ?? 0).toBeGreaterThan(0);
  return settings.hooks.PreToolUse ?? [];
}

/** The Codex launch channel: the per-spawn `-c hooks.<Event>=…` overrides, parsed back as real TOML. */
function codexSessionGate(door: { ownershipOnly: boolean }): OwnershipHookGroup[] {
  const harness = new HarnessManager(fixture.authority);
  const plan = planFor("codex");
  const config = harness.materializeCodexSessionStartHookConfig(
    "delegado",
    door.ownershipOnly ? undefined : path.join(fixture.authority, ".tachyon", "HANDOFF.md"),
    { silentPersistence: !door.ownershipOnly, projectedHooks: plan.hooks },
  );
  const values = Array.isArray(config) ? config : [config];
  expect(values.some((value) => value.startsWith("hooks.SessionStart="))).toBe(true);
  const gate = values.find((value) => value.startsWith("hooks.PreToolUse="));
  if (!gate) return [];
  // Parsed as TOML rather than pattern-matched: Codex will parse it, so an override that only LOOKS
  // right is a defect this must catch.
  const parsed = TOML.parse(gate) as { hooks?: { PreToolUse?: OwnershipHookGroup[] } };
  return parsed.hooks?.PreToolUse ?? [];
}

function onlyCommand(groups: OwnershipHookGroup[]): string {
  expect(groups).toHaveLength(1);
  expect(groups[0]!.hooks).toHaveLength(1);
  return groups[0]!.hooks[0]!.command;
}

describe("t-09edf2 — Agent Claude × create/restart/resume/fork: layer 2 reaches the delegated session", () => {
  // Every door goes through the same materializer, and they differ in exactly one observable: whether
  // lifecycle hooks (handoff + persistence) are attached. Both settings are exercised so the gate can
  // never depend on the thing that differs.
  for (const door of [
    { trigger: "create", ownershipOnly: false },
    { trigger: "restart", ownershipOnly: false },
    { trigger: "resume", ownershipOnly: false },
    { trigger: "fork (Temporary sibling — lifecycle hooks off)", ownershipOnly: true },
  ]) {
    it(`${door.trigger}: 'git commit --no-verify' is refused with exit 2 before Git runs`, () => {
      const command = onlyCommand(claudeSessionGate(door));
      const refused = runGate(command, "git commit --no-verify -m 'wip'");
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("--no-verify");
    });

    it(`${door.trigger}: an ordinary commit still reaches layer 1 (exit 0, not blocked here)`, () => {
      const command = onlyCommand(claudeSessionGate(door));
      expect(runGate(command, "git commit -m 'ordinary'").status).toBe(0);
    });
  }

  it("the other bypass shapes are refused too, so the gate is not a single-flag check", () => {
    const command = onlyCommand(claudeSessionGate({ ownershipOnly: false }));
    expect(runGate(command, "git commit -am 'wip'").status).toBe(2);
    expect(runGate(command, "git add -A && git commit -m 'wip'").status).toBe(2);
    expect(runGate(command, "git commit -n -m 'wip'").status).toBe(2);
  });

  it("the Claude group carries no statusMessage — a Codex-only field would be an authoring error", () => {
    const groups = claudeSessionGate({ ownershipOnly: false });
    expect(groups[0]!.hooks[0]!.statusMessage).toBeUndefined();
    expect(groups[0]!.matcher).toBe("Bash");
  });
});

describe("t-09edf2 — Agent Codex × create/restart/resume/fork: layer 2 reaches the delegated session", () => {
  for (const door of [
    { trigger: "create", ownershipOnly: false },
    { trigger: "restart", ownershipOnly: false },
    { trigger: "resume", ownershipOnly: false },
    { trigger: "fork (Temporary sibling — lifecycle hooks off)", ownershipOnly: true },
  ]) {
    it(`${door.trigger}: 'git commit --no-verify' is refused with exit 2 before Git runs`, () => {
      const command = onlyCommand(codexSessionGate(door));
      const refused = runGate(command, "git commit --no-verify -m 'wip'");
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("--no-verify");
    });

    it(`${door.trigger}: an ordinary commit still reaches layer 1 (exit 0, not blocked here)`, () => {
      expect(runGate(onlyCommand(codexSessionGate(door)), "git commit -m 'ordinary'").status).toBe(0);
    });
  }

  it("keeps Codex's statusMessage and its own matcher dialect", () => {
    const groups = codexSessionGate({ ownershipOnly: false });
    expect(groups[0]!.matcher).toBe("^Bash$");
    expect(groups[0]!.hooks[0]!.statusMessage).toBe("secrets-guard shape-gate");
  });

  it("a command carrying a newline is escaped, not allowed to end the TOML value early", () => {
    const plan = planProjectedPluginHooks({
      plugins: [{
        name: "secrets-guard",
        version: "2.0.4",
        targets: [{
          runtime: "codex",
          kind: "settings-hook",
          file: ".codex/hooks.json",
          ref: "PreToolUse",
          removal: [{ hooks: [{ type: "command", command: "echo one\nmodel = \"evil\"" }] }],
        }],
      }],
      runtime: "codex",
      policy: POLICY,
    });
    const harness = new HarnessManager(fixture.authority);
    const config = harness.materializeCodexSessionStartHookConfig("delegado", undefined, { projectedHooks: plan.hooks });
    const gate = (Array.isArray(config) ? config : [config]).find((value) => value.startsWith("hooks.PreToolUse="))!;
    const parsed = TOML.parse(gate) as { hooks?: { PreToolUse?: OwnershipHookGroup[] }; model?: string };
    expect(parsed.model).toBeUndefined();
    expect(parsed.hooks!.PreToolUse![0]!.hooks[0]!.command).toBe('echo one\nmodel = "evil"');
  });
});

describe("t-09edf2 — Interface × install: the authority lockfile is the source, and no live session is touched", () => {
  it("an uninstalled workspace projects nothing; installing makes the NEXT spawn project it", () => {
    const fresh = makeTempDir("tachyon-guard-fresh-");
    expect(planFor("claude", { authority: fresh }).hooks).toEqual({});

    lockfileWith(fresh, ["claude"]);
    const after = planFor("claude", { authority: fresh });
    expect(after.projected.map((entry) => `${entry.plugin} ${entry.event}`)).toEqual(["secrets-guard PreToolUse"]);
  });

  it("a policy naming a plugin that is not installed says so instead of failing silently", () => {
    const fresh = makeTempDir("tachyon-guard-absent-");
    const plan = planFor("claude", { authority: fresh });
    expect(plan.withheld).toEqual([{ plugin: "secrets-guard", reason: "is classified 'enforcement' but is not installed in this workspace" }]);
  });

  it("the projection writes nothing into the workspace's own installed settings", () => {
    const before = fs.readFileSync(path.join(fixture.authority, ".claude", "settings.json"), "utf8");
    claudeSessionGate({ ownershipOnly: false });
    expect(fs.readFileSync(path.join(fixture.authority, ".claude", "settings.json"), "utf8")).toBe(before);
  });
});

describe("t-09edf2 — Tachyon × crash-recovery: the custodied record is restored, the environment is not imported", () => {
  it("a `.claude/settings.json` sitting in the agent's own worktree contributes nothing", () => {
    fs.mkdirSync(path.join(fixture.worktree, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.worktree, ".claude", "settings.json"),
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 0" }] }] } })}\n`,
    );
    const groups = claudeSessionGate({ ownershipOnly: false });
    expect(groups.map((group) => group.hooks[0]!.command)).toEqual([guardCommand(fixture.authority, "claude")]);
  });

  it("recovery re-derives the identical plan from the lockfile, so a recovered session is gated like a fresh one", () => {
    const fresh = planFor("claude");
    const recovered = planFor("claude");
    expect(recovered).toEqual(fresh);
    expect(onlyCommand(recovered.hooks.PreToolUse as OwnershipHookGroup[])).toBe(guardCommand(fixture.authority, "claude"));
  });

  it("a lockfile whose recorded groups are corrupt withholds the gate and names why", () => {
    const broken = makeTempDir("tachyon-guard-broken-");
    fs.mkdirSync(path.join(broken, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(broken, ".tachyon", "plugins.lock.json"), `${JSON.stringify({
      schemaVersion: 1,
      plugins: {
        "secrets-guard": {
          name: "secrets-guard",
          version: "2.0.4",
          runtimes: ["claude"],
          targets: [{ runtime: "claude", kind: "settings-hook", file: ".claude/settings.json", ref: "PreToolUse", removal: "not-a-group-list" }],
        },
      },
    })}\n`);
    const plan = planFor("claude", { authority: broken });
    expect(plan.hooks).toEqual({});
    expect(plan.withheld[0]!.reason).toContain("unreadable");
  });
});

describe("t-836be3 — Grok HAS a projectable channel; what is missing is the plugin's block", () => {
  it("no longer refuses the runtime by name — the reason is now the plugin's missing grok block", () => {
    // This assertion used to read "runtime 'grok' has no Tachyon-owned per-spawn hook channel". That was
    // measured false on 2026-08-02 (grok 0.2.114): `$GROK_HOME/hooks/*.json` is a Global, always-trusted
    // source and its `deny` blocks the tool call. The honest withheld line is about `secrets-guard` 2.0.4,
    // which declares claude and codex blocks and no grok one.
    const plan = planFor("grok");
    expect(plan.hooks).toEqual({});
    expect(plan.withheld).toEqual([{
      plugin: "secrets-guard",
      reason: "installs no grok settings-hook — its manifest declares no grok block",
    }]);
  });

  it("an unrecognized runtime is still refused by name, so the fail-closed default is intact", () => {
    const plan = planFor("gemini");
    expect(plan.hooks).toEqual({});
    expect(plan.withheld).toEqual([{
      plugin: "secrets-guard",
      reason: "runtime 'gemini' has no Tachyon-owned per-spawn hook channel — layer 2 is NOT projected there",
    }]);
  });

  it("a plugin with no block for the runtime is reported, not silently skipped", () => {
    const claudeOnly = makeTempDir("tachyon-guard-claude-only-");
    fs.mkdirSync(path.join(claudeOnly, ".tachyon", "plugins", "secrets-guard", "claude"), { recursive: true });
    lockfileWith(claudeOnly, ["claude"]);
    const plan = planFor("codex", { authority: claudeOnly });
    expect(plan.hooks).toEqual({});
    expect(plan.withheld).toEqual([{
      plugin: "secrets-guard",
      reason: "installs no codex settings-hook — its manifest declares no codex block",
    }]);
  });
});

describe("t-09edf2 — the standing inheritance ruling still holds", () => {
  it("an unclassified plugin projects nothing, whatever it installs", () => {
    const plan = planFor("claude", { policy: {} });
    expect(plan.hooks).toEqual({});
    expect(plan.withheld).toEqual([{
      plugin: "secrets-guard",
      reason: "installs claude settings-hooks but settings.agentHookProjection does not classify it — nothing is projected",
    }]);
  });

  it("a class other than 'enforcement' is refused — classification buys refusal, never reach", () => {
    for (const hookClass of ["capability", "prompt-transform", "observability"] as const) {
      const plan = planFor("claude", { policy: { "secrets-guard": hookClass } });
      expect(plan.hooks).toEqual({});
      expect(plan.withheld[0]!.reason).toContain(`classified '${hookClass}'`);
    }
  });

  it("an enforcement class cannot project a non-gate event", () => {
    const plan = planProjectedPluginHooks({
      plugins: [{
        name: "chatty",
        version: "1.0.0",
        targets: [{
          runtime: "claude",
          kind: "settings-hook",
          file: ".claude/settings.json",
          ref: "UserPromptSubmit",
          removal: [{ hooks: [{ type: "command", command: "echo injected" }] }],
        }],
      }],
      runtime: "claude",
      policy: { chatty: "enforcement" },
    });
    expect(plan.hooks).toEqual({});
    expect(plan.withheld[0]!.reason).toContain("is not a gate event");
  });

  it("SessionStart and Stop are Tachyon's lifecycle channel and are never displaced by a projection", () => {
    const harness = new HarnessManager(fixture.authority);
    const file = harness.materializeOwnershipSettings("delegado", undefined, {
      silentPersistence: true,
      projectedHooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hijack" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo hijack" }] }],
      },
    });
    const settings = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, OwnershipHookGroup[]> };
    const commands = [...settings.hooks.SessionStart!, ...settings.hooks.Stop!].flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands.some((command) => command.includes("hijack"))).toBe(false);
  });
});

/**
 * t-836be3 — the Grok channel: `$GROK_HOME/hooks/`.
 *
 * Measured on grok 0.2.114 before a line of this was written, in a real headless session:
 *
 *  - `$GROK_HOME/hooks/*.json` is a Global, always-trusted source — no folder-trust, so it reaches a
 *    delegated worktree that has no `.grok/` tree of its own.
 *  - A `PreToolUse` `deny` from it blocks the tool call even under `--yolo`
 *    (`permissionMode=bypassPermissions`); `git rev-list --all --count` stayed 0, i.e. Git never ran.
 *  - The envelope is camelCase: `{"toolName":"run_terminal_command","toolInput":{"command":…}}`. There is
 *    no `tool_input`, which is why the gate below reads `toolInput` and why deriving Grok's groups from a
 *    plugin's claude block is refused rather than treated as free: `secrets-guard`'s claude `guard.sh`
 *    reads `.tool_input.command` and, fed the real Grok payload, exits 0 — a gate that silently ALLOWS.
 */
const GROK_GUARD_SOURCE = `// layer-2 shape gate (test fixture) — Grok dialect: camelCase envelope.
let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let command = "";
  try { command = JSON.parse(raw || "{}")?.toolInput?.command ?? ""; } catch { command = ""; }
  if (/(^|[;&|]\\s*)git\\s+(?:-[^\\s]+\\s+)*commit\\b/.test(command) && /\\s(?:--no-verify|-n)(?=\\s|$)/.test(command)) {
    process.stderr.write("--no-verify skips the gitleaks pre-commit gate\\n");
    process.exit(2);
  }
  process.exit(0);
});
`;

/** The payload Grok actually writes to a hook's stdin (transcribed from the measured envelope). */
function grokPayload(command: string): string {
  return JSON.stringify({
    hookEventName: "pre_tool_use",
    toolName: "run_terminal_command",
    toolInput: { command, description: "run it" },
    toolInputTruncated: false,
    permissionMode: "bypassPermissions",
  });
}

function grokGuardCommand(authority: string): string {
  const script = path.join(authority, ".tachyon", "plugins", "secrets-guard", "grok", "guard.cjs");
  return `if [ ! -f '${script}' ]; then echo '[tachyon] plugin hook root missing' >&2; exit 2; fi; node '${script}'`;
}

/**
 * A grok `settings-hook` target, hand-built rather than read from the lockfile.
 *
 * Not a shortcut — the lockfile CANNOT carry one yet (`manifest.SUPPORTED_RUNTIMES` is claude+codex, so
 * `parseLockfile` rejects `runtime: "grok"`), which is the install-side half of this gap and its own
 * follow-up. `HookProjectionCandidate` types `runtime` as a plain string precisely so a caller may pass a
 * hand-built record, and the test below pins that the lockfile door is still shut, so this cannot quietly
 * become a claim that installing works.
 */
function grokCandidate(
  authority: string,
  options: { event?: string; statusMessage?: boolean } = {},
): HookProjectionCandidate {
  return {
    name: "secrets-guard",
    version: "2.0.4",
    targets: [{
      runtime: "grok",
      kind: "settings-hook",
      file: ".grok/hooks/secrets-guard.json",
      ref: options.event ?? "PreToolUse",
      removal: [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: grokGuardCommand(authority),
          ...(options.statusMessage ? { statusMessage: "secrets-guard shape-gate" } : {}),
        }],
      }],
    }],
  };
}

function grokPlan(options: { authority?: string; event?: string; statusMessage?: boolean; policy?: AgentHookProjectionPolicy } = {}) {
  return planProjectedPluginHooks({
    plugins: [grokCandidate(options.authority ?? fixture.authority, options)],
    runtime: "grok",
    policy: options.policy ?? POLICY,
  });
}

let grokAuthHome: string;

/** A HarnessManager whose "real" `~/.grok` holds a credential, so the private-home materializers run. */
function grokManager(authority: string = fixture.authority): HarnessManager {
  return new HarnessManager(authority, undefined, process.env, undefined, undefined, undefined, undefined, grokAuthHome);
}

function readProjected(hooksRoot: string): Record<string, OwnershipHookGroup[]> {
  const file = path.join(hooksRoot, "projected.json");
  if (!fs.existsSync(file)) return {};
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, OwnershipHookGroup[]> }).hooks;
}

describe("t-836be3 — Agent Grok × create/restart/resume/fork: the gate reaches the session's own GROK_HOME", () => {
  beforeAll(() => {
    grokAuthHome = makeTempDir("tachyon-guard-real-grok-");
    fs.writeFileSync(path.join(grokAuthHome, "auth.json"), '{"token":"GROK"}');
    const dir = path.join(fixture.authority, ".tachyon", "plugins", "secrets-guard", "grok");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "guard.cjs"), GROK_GUARD_SOURCE);
  });

  // Every non-harness door — Temporary create, restart, resume, fork, and the canonical profile path —
  // reaches `materializeBridgeMcpGrok`, which is the GROK_HOME real Grok agents run with. The harness
  // door is a different materializer and gets its own case below rather than being assumed equivalent.
  for (const door of [
    { trigger: "create (Temporary, undeclared)", exactTrust: false },
    { trigger: "restart", exactTrust: false },
    { trigger: "resume", exactTrust: false },
    { trigger: "fork (no profile visible to the port)", exactTrust: false },
    { trigger: "canonical profile (exactTrust)", exactTrust: true },
  ]) {
    it(`${door.trigger}: 'git commit --no-verify' is refused with exit 2 before Git runs`, () => {
      const home = grokManager().materializeBridgeMcpGrok("delegado", { url: "http://127.0.0.1:9/mcp" }, fixture.worktree, {
        exactTrust: door.exactTrust,
        projectedHooks: grokPlan().hooks,
      });
      expect(home).toBe(bridgeGrokHome(fixture.authority, "delegado"));
      const groups = readProjected(path.join(home, "hooks")).PreToolUse ?? [];
      const command = onlyCommand(groups);
      const result = spawnSync("sh", ["-c", command], {
        input: grokPayload("git commit --no-verify -m 'wip'"),
        cwd: fixture.worktree,
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--no-verify");
    });
  }

  it("an ordinary commit still falls through to layer 1", () => {
    const home = grokManager().materializeBridgeMcpGrok("delegado", { url: "http://127.0.0.1:9/mcp" }, fixture.worktree, {
      projectedHooks: grokPlan().hooks,
    });
    const command = onlyCommand(readProjected(path.join(home, "hooks")).PreToolUse ?? []);
    const result = spawnSync("sh", ["-c", command], { input: grokPayload("git commit -m 'ordinary'"), cwd: fixture.worktree, encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("harness door: the same gate lands in the harness home's .grok/hooks, alongside the lifecycle hooks", () => {
    const mgr = grokManager();
    mgr.materialize("harnessed", {} as never, adapterForRuntime("grok")!, fixture.worktree, undefined, {
      projectedHooks: grokPlan().hooks,
    });
    const hooksRoot = path.join(harnessHome(fixture.authority, "harnessed"), ".grok", "hooks");
    expect(onlyCommand(readProjected(hooksRoot).PreToolUse ?? [])).toBe(grokGuardCommand(fixture.authority));
    // The lifecycle channel is untouched: ownership still records, in its own file.
    const start = JSON.parse(fs.readFileSync(path.join(hooksRoot, "session-start.json"), "utf8")) as { hooks: Record<string, OwnershipHookGroup[]> };
    expect(start.hooks.SessionStart!.length).toBeGreaterThan(0);
  });

  it("a reclassified or uninstalled plugin REMOVES the gate — a stale projected.json would keep gating", () => {
    // $GROK_HOME outlives a spawn, so "write nothing" is not the same as "remove". The measured failure
    // mode this guards is the mirror of the one the task exists for: a session gated by a policy the
    // human already revoked.
    const mgr = grokManager();
    const home = mgr.materializeBridgeMcpGrok("delegado", { url: "http://127.0.0.1:9/mcp" }, fixture.worktree, {
      projectedHooks: grokPlan().hooks,
    });
    expect(fs.existsSync(path.join(home, "hooks", "projected.json"))).toBe(true);
    mgr.materializeBridgeMcpGrok("delegado", { url: "http://127.0.0.1:9/mcp" }, fixture.worktree, {
      projectedHooks: grokPlan({ policy: { "secrets-guard": "observability" } }).hooks,
    });
    expect(fs.existsSync(path.join(home, "hooks", "projected.json"))).toBe(false);
  });

  it("SessionStart and Stop cannot be displaced through the Grok channel either", () => {
    const mgr = grokManager();
    const home = mgr.materializeBridgeMcpGrok("hijacker", { url: "http://127.0.0.1:9/mcp" }, fixture.worktree, {
      projectedHooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hijack" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo hijack" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "exit 0" }] }],
      },
    });
    const projected = readProjected(path.join(home, "hooks"));
    expect(Object.keys(projected)).toEqual(["PreToolUse"]);
  });
});

describe("t-836be3 — what the Grok plan accepts, and what it refuses", () => {
  it("projects the gate event from a grok block", () => {
    const plan = grokPlan();
    expect(plan.projected).toEqual([{ plugin: "secrets-guard", version: "2.0.4", event: "PreToolUse", groups: 1 }]);
    expect(onlyCommand(plan.hooks.PreToolUse as OwnershipHookGroup[])).toBe(grokGuardCommand(fixture.authority));
  });

  it("a grok-only event that is not a gate is withheld — enforcement buys refusal, not reach", () => {
    // `PermissionDenied` exists in Grok's event table and in neither claude's nor codex's, so this also
    // proves GROK_HOOK_EVENTS is Grok's own set rather than a neighbour's copied across.
    const plan = grokPlan({ event: "PermissionDenied" });
    expect(plan.hooks).toEqual({});
    expect(plan.withheld[0]!.reason).toContain("is not a gate event");
  });

  it("an event Grok does not have is withheld as unknown, not silently inert", () => {
    // Grok "skips unrecognized event names" (guide § Key Fields), so a typo would never be reported by
    // the runtime. Failing closed here is the only place a human hears about it.
    const plan = grokPlan({ event: "PreToolUsage" });
    expect(plan.hooks).toEqual({});
    expect(plan.withheld[0]!.reason).toContain("unknown event");
  });

  it("a statusMessage is refused for grok — it is a Codex-only field", () => {
    const plan = grokPlan({ statusMessage: true });
    expect(plan.hooks).toEqual({});
    expect(plan.withheld[0]!.reason).toContain("not valid for grok");
  });

  it("a plugin with only a claude block projects NOTHING for grok — no silent derivation", () => {
    // Grok reads claude-shaped hook JSON, which makes deriving look free. Measured: `secrets-guard`'s
    // claude guard.sh reads `.tool_input.command`; fed the real Grok camelCase payload it exits 0. A
    // derived gate would claim to refuse and would allow.
    const plan = planFor("grok");
    expect(plan.hooks).toEqual({});
    expect(plan.withheld).toEqual([{ plugin: "secrets-guard", reason: "installs no grok settings-hook — its manifest declares no grok block" }]);
  });

  it("the install door is still shut: a lockfile naming a grok target yields no grok candidate", () => {
    // The remaining half of the gap, pinned so it cannot be mistaken for working. When
    // `manifest.SUPPORTED_RUNTIMES` gains grok this fails, and whoever lands it updates this line.
    const authority = makeTempDir("tachyon-guard-grok-lock-");
    fs.mkdirSync(path.join(authority, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(authority, ".tachyon", "plugins.lock.json"), `${JSON.stringify({
      schemaVersion: 1,
      plugins: {
        "secrets-guard": {
          name: "secrets-guard",
          version: "2.0.4",
          runtimes: ["grok"],
          targets: [{ runtime: "grok", kind: "settings-hook", file: ".grok/hooks/secrets-guard.json", ref: "PreToolUse", removal: [{ hooks: [{ type: "command", command: "exit 2" }] }] }],
        },
      },
    }, null, 2)}\n`);
    expect(readHookProjectionCandidates(authority)).toEqual([]);
    expect(planFor("grok", { authority }).hooks).toEqual({});
  });
});
