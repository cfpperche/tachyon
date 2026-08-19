/**
 * t-685a0c — `settings.checklist.requireIn` must REFUSE, in a workspace that has nothing but Tachyon.
 *
 * The framing error this file exists to prevent: `t-cb684f` proved the reminder never reached a
 * Temporary agent, and the first answer was to write the requirement into this repository's
 * `docs/project-guidance.md` — which fixed our workspace and left the product broken, because that
 * file does not ship. So the fixture below is a bare temp directory holding one `tachyon.yml` and
 * nothing else: no `docs/project-guidance.md`, no plugin lockfile, no `.claude`/`.codex` tree. If any
 * of these tests needed a file that only exists in this checkout, it would not be evidence about the
 * product.
 *
 * Every case EXECUTES the command the runtime will run, with a real `PreToolUse` payload on stdin, and
 * asserts the exit code the runtime acts on — the same standard `secretsGuardLayer2Projection.test.ts`
 * set after a settings file that merely LOOKED right let `git commit --no-verify` through for a day.
 * The command is read back out of the real per-spawn channel (the `--settings` JSON, the `-c hooks.…`
 * TOML, the `$GROK_HOME/hooks/projected.json`), never hand-built here.
 *
 * The negative control is not decoration. A gate that refused every agent would pass the positive test
 * exactly as well as a correct one; only "`requireIn` empty or kind not covered produces ZERO groups"
 * tells the two apart.
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import TOML from "@iarna/toml";
import { HarnessManager, bridgeGrokHome } from "@tachyon/engine/harness/HarnessManager.js";
import { codexToolHookFile, type OwnershipHookGroup } from "@tachyon/engine/activity/sessionOwners.js";
import { loadConfigFile } from "@tachyon/engine/config/loadConfig.js";
import {
  CHECKLIST_GATE_SCRIPT_SOURCE,
  checklistGateRefusal,
  checklistGateScriptPath,
  planChecklistGateHooks,
} from "@tachyon/engine/runtime/checklistGateHook.js";
import { makeTempDir } from "../helpers/tempDir.js";

const SESSION = "01a01582-a2bf-7b42-a1a9-8a986db1a2ee";

interface Fixture {
  /** The workspace someone who just installed Tachyon has: a `tachyon.yml`, and nothing else. */
  root: string;
  /** The agent's cwd — a delegated worktree, with no configuration of its own. */
  worktree: string;
  /** The private claude config home Tachyon materializes per spawn; its `tasks/` is the plan store. */
  claudeHome: string;
  /** Stand-in for the real `~/.grok`, so the private-home materializer finds a credential. */
  grokAuthHome: string;
}

let fixture: Fixture;

/** The clean workspace: one `tachyon.yml` that declares the capability, and deliberately nothing else. */
function writeWorkspace(root: string, requireIn: readonly string[]): void {
  const list = requireIn.length === 0 ? "[]" : `[${requireIn.map((kind) => `"${kind}"`).join(", ")}]`;
  fs.writeFileSync(
    path.join(root, "tachyon.yml"),
    ["agents: {}", "settings:", "  checklist:", `    requireIn: ${list}`, ""].join("\n"),
  );
}

/** Read `requireIn` back through the SHIPPED loader, so the test proves the tachyon.yml key reaches it. */
function requireInFromDisk(root: string): readonly string[] | undefined {
  const parsed = loadConfigFile(path.join(root, "tachyon.yml"));
  return parsed.config?.settings.checklist?.requireIn;
}

beforeAll(() => {
  const root = makeTempDir("tachyon-checklist-gate-ws-");
  writeWorkspace(root, ["feature"]);
  const grokAuthHome = makeTempDir("tachyon-checklist-gate-grok-");
  fs.writeFileSync(path.join(grokAuthHome, "auth.json"), '{"token":"GROK"}');
  fixture = {
    root,
    worktree: makeTempDir("tachyon-checklist-gate-wt-"),
    claudeHome: makeTempDir("tachyon-checklist-gate-home-"),
    grokAuthHome,
  };
  // What `Workspace.ensureChecklistGateScript` does at spawn.
  const script = checklistGateScriptPath(root);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, CHECKLIST_GATE_SCRIPT_SOURCE);
});

function managerFor(root: string): HarnessManager {
  return new HarnessManager(root, undefined, process.env, undefined, undefined, undefined, undefined, fixture.grokAuthHome);
}

interface RuntimeCase {
  runtime: "claude" | "codex" | "grok";
  /** The plan-ledger location Tachyon bakes into the command, or "" when the script reads its env. */
  planRoot(): string;
  /** Extra environment the runtime gives its hook process. */
  env(): Record<string, string>;
  /** A real PreToolUse payload for a MUTATING tool, in that runtime's own envelope dialect. */
  mutatingPayload(): string;
  /** A real PreToolUse payload for a read-only tool. */
  readingPayload(): string;
  /** Put a written plan into that runtime's own ledger, exactly where the runtime writes it. */
  writePlan(): void;
  /** Undo it, so ordering between cases cannot leak a plan into a test that must see none. */
  clearPlan(): void;
  /** Read the command back out of the real per-spawn channel. */
  channelGroups(root: string): OwnershipHookGroup[];
}

function claudeTasksRoot(): string {
  return path.join(fixture.claudeHome, "tasks");
}

function grokSessionsRoot(): string {
  return path.join(fixture.grokAuthHome, "sessions");
}

function grokSessionDir(): string {
  return path.join(grokSessionsRoot(), encodeURIComponent(fixture.worktree), SESSION);
}

/** The gate block a spawn would install, for a workspace whose `requireIn` is read off disk. */
function gateHooks(root: string, taskKind: string | undefined, runtime: string, planRoot: string) {
  return planChecklistGateHooks({
    runtime,
    requireIn: requireInFromDisk(root),
    taskKind,
    scriptPath: checklistGateScriptPath(root),
    planRoot,
    failureFile: path.join(root, ".tachyon", "activity", "persistence-hooks-failures.jsonl"),
  });
}

const CASES: RuntimeCase[] = [
  {
    runtime: "claude",
    planRoot: () => claudeTasksRoot(),
    env: () => ({}),
    mutatingPayload: () =>
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: fixture.worktree, tool_name: "Edit", tool_input: { file_path: "a.ts" } }),
    readingPayload: () =>
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: fixture.worktree, tool_name: "Read", tool_input: { file_path: "a.ts" } }),
    writePlan: () => {
      const dir = path.join(claudeTasksRoot(), SESSION);
      fs.mkdirSync(dir, { recursive: true });
      // The exact shape the TaskCreate store writes (measured 2026-08-18 on Claude Code 2.1.234).
      fs.writeFileSync(
        path.join(dir, "1.json"),
        `${JSON.stringify({ id: "1", subject: "Measure the channels", description: "…", status: "pending", blocks: [], blockedBy: [] }, null, 2)}\n`,
      );
    },
    clearPlan: () => fs.rmSync(claudeTasksRoot(), { recursive: true, force: true }),
    channelGroups: (root) => {
      const harness = managerFor(root);
      const file = harness.materializeOwnershipSettings("delegado", undefined, {
        silentPersistence: false,
        ...(gateHooks(root, "feature", "claude", claudeTasksRoot()) ? { projectedHooks: gateHooks(root, "feature", "claude", claudeTasksRoot())! } : {}),
      });
      const settings = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, OwnershipHookGroup[]> };
      // The lifecycle channel must survive intact — a gate that displaced SessionStart would turn
      // Activity off to require a plan.
      expect(settings.hooks.SessionStart?.length ?? 0).toBeGreaterThan(0);
      return settings.hooks.PreToolUse ?? [];
    },
  },
  {
    runtime: "codex",
    planRoot: () => codexToolHookFile(fixture.root),
    env: () => ({}),
    mutatingPayload: () =>
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: fixture.worktree, tool_name: "Bash", tool_input: { command: "echo hi > a.ts" } }),
    readingPayload: () =>
      JSON.stringify({ hook_event_name: "PreToolUse", session_id: SESSION, cwd: fixture.worktree, tool_name: "Read", tool_input: {} }),
    writePlan: () => {
      const file = codexToolHookFile(fixture.root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A verbatim row shape from this workspace's own ledger (t-cb684f's positive control).
      fs.writeFileSync(
        file,
        `${JSON.stringify({ agent: "delegado", event: "PreToolUse", sessionId: SESSION, turnId: "t1", toolName: "update_plan", ts: "2026-08-18T00:51:09.999Z", toolInput: { plan: [{ step: "one", status: "in_progress" }] } })}\n`,
      );
    },
    clearPlan: () => fs.rmSync(codexToolHookFile(fixture.root), { force: true }),
    channelGroups: (root) => {
      const harness = managerFor(root);
      const plan = gateHooks(root, "feature", "codex", codexToolHookFile(root));
      const config = harness.materializeCodexSessionStartHookConfig("delegado", undefined, {
        silentPersistence: false,
        ...(plan ? { projectedHooks: plan } : {}),
      });
      const values = Array.isArray(config) ? config : [config];
      expect(values.some((value) => value.startsWith("hooks.SessionStart="))).toBe(true);
      const gate = values.find((value) => value.startsWith("hooks.PreToolUse="));
      if (!gate) return [];
      // Parsed as TOML because codex will parse it: an override that only LOOKS right is a defect.
      const parsed = TOML.parse(gate) as { hooks?: { PreToolUse?: OwnershipHookGroup[] } };
      // t-17b510's update_plan recorder rides the same `-c` override; it is not this gate.
      return (parsed.hooks?.PreToolUse ?? []).filter((group) => group.matcher !== "^update_plan$");
    },
  },
  {
    runtime: "grok",
    // Not baked: grok's `updates.jsonl` lives under the private `$GROK_HOME` the harness materializes,
    // so the script reads that env var. Passing "" here is the production shape, not a shortcut.
    planRoot: () => "",
    env: () => ({ GROK_HOME: fixture.grokAuthHome }),
    mutatingPayload: () =>
      JSON.stringify({ hookEventName: "pre_tool_use", sessionId: SESSION, cwd: fixture.worktree, workspaceRoot: fixture.worktree, toolName: "search_replace", toolInput: { file_path: "a.ts" } }),
    readingPayload: () =>
      JSON.stringify({ hookEventName: "pre_tool_use", sessionId: SESSION, cwd: fixture.worktree, workspaceRoot: fixture.worktree, toolName: "read_file", toolInput: {} }),
    writePlan: () => {
      const dir = grokSessionDir();
      fs.mkdirSync(dir, { recursive: true });
      // A verbatim row from the 2026-08-18 grok 1.0.5 probe's own `updates.jsonl`.
      fs.writeFileSync(
        path.join(dir, "updates.jsonl"),
        `${JSON.stringify({ timestamp: 1787067310, method: "session/update", params: { sessionId: SESSION, update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "todo_write", rawInput: { todos: [{ id: "1", content: "one", status: "in_progress" }] } } } })}\n`,
      );
    },
    clearPlan: () => {
      // The session DIRECTORY stays: grok creates it at session start, and its absence means "we could
      // not locate this session", which must allow. Removing only the ledger is the real no-plan shape.
      fs.mkdirSync(grokSessionDir(), { recursive: true });
      fs.rmSync(path.join(grokSessionDir(), "updates.jsonl"), { force: true });
    },
    channelGroups: (root) => {
      const harness = managerFor(root);
      const plan = gateHooks(root, "feature", "grok", "");
      const home = harness.materializeBridgeMcpGrok("delegado", { url: "http://127.0.0.1:9/mcp" }, fixture.worktree, {
        ...(plan ? { projectedHooks: plan } : {}),
      });
      expect(home).toBe(bridgeGrokHome(root, "delegado"));
      const file = path.join(home, "hooks", "projected.json");
      if (!fs.existsSync(file)) return [];
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, OwnershipHookGroup[]> }).hooks.PreToolUse ?? [];
    },
  },
];

function onlyCommand(groups: OwnershipHookGroup[]): string {
  expect(groups).toHaveLength(1);
  expect(groups[0]!.hooks).toHaveLength(1);
  return groups[0]!.hooks[0]!.command;
}

/** Run the hook exactly as the runtime does: `sh -c`, payload on stdin, in the agent's cwd. */
function runGate(command: string, input: string, env: Record<string, string> = {}): { status: number; stderr: string } {
  const result = spawnSync("sh", ["-c", command], {
    input,
    cwd: fixture.worktree,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

describe.each(CASES)("t-685a0c — $runtime: the required plan blocks the first change and nothing else", (testCase) => {
  it("ACCEPTANCE — no plan yet: the first mutating tool is REFUSED, and the refusal names this runtime's plan tool", () => {
    testCase.clearPlan();
    const command = onlyCommand(testCase.channelGroups(fixture.root));
    const refused = runGate(command, testCase.mutatingPayload(), testCase.env());
    expect(refused.status).toBe(2);
    expect(refused.stderr.trim()).toBe(checklistGateRefusal(testCase.runtime));
    // Lock 4: a refusal that does not teach the way out becomes a loop, so the exact tool name is
    // asserted rather than left to the sentence above staying whatever it happens to be.
    const named = { claude: "TaskCreate", codex: "update_plan", grok: "todo_write" }[testCase.runtime];
    expect(refused.stderr).toContain(named);
  });

  it("ACCEPTANCE — the plan is written: the SAME command, the SAME payload, now passes", () => {
    const command = onlyCommand(testCase.channelGroups(fixture.root));
    testCase.writePlan();
    expect(runGate(command, testCase.mutatingPayload(), testCase.env()).status).toBe(0);
    testCase.clearPlan();
  });

  it("reads always pass — with no plan anywhere, a read-only tool is not touched", () => {
    testCase.clearPlan();
    const command = onlyCommand(testCase.channelGroups(fixture.root));
    expect(runGate(command, testCase.readingPayload(), testCase.env()).status).toBe(0);
  });

  it("fail OPEN — an unparseable payload and a payload with no session id both pass", () => {
    testCase.clearPlan();
    const command = onlyCommand(testCase.channelGroups(fixture.root));
    expect(runGate(command, "not json at all", testCase.env()).status).toBe(0);
    const anonymous = JSON.parse(testCase.mutatingPayload()) as Record<string, unknown>;
    delete anonymous.session_id;
    delete anonymous.sessionId;
    expect(runGate(command, JSON.stringify(anonymous), testCase.env()).status).toBe(0);
  });

  it("NEGATIVE CONTROL — `requireIn` empty: the channel carries no gate at all, so nothing can refuse", () => {
    const empty = makeTempDir("tachyon-checklist-gate-off-");
    writeWorkspace(empty, []);
    fs.mkdirSync(path.dirname(checklistGateScriptPath(empty)), { recursive: true });
    fs.writeFileSync(checklistGateScriptPath(empty), CHECKLIST_GATE_SCRIPT_SOURCE);
    expect(gateHooks(empty, "feature", testCase.runtime, testCase.planRoot())).toBeUndefined();
    // And through the real channel: an absent group is observably different from a group that allowed.
    expect(testCase.channelGroups(empty)).toHaveLength(0);
  });

  it("NEGATIVE CONTROL — a kind `requireIn` does not cover, and no task at all: no gate either", () => {
    expect(gateHooks(fixture.root, "chore", testCase.runtime, testCase.planRoot())).toBeUndefined();
    expect(gateHooks(fixture.root, undefined, testCase.runtime, testCase.planRoot())).toBeUndefined();
  });
});

describe("t-685a0c — the locks that are not per-runtime", () => {
  it("a runtime with no measured per-spawn channel is never gated, rather than gated on a guess", () => {
    for (const runtime of ["pi", "opencode", "hermes", "gemini"]) {
      expect(gateHooks(fixture.root, "feature", runtime, "")).toBeUndefined();
    }
  });

  it("'cannot read' is not 'is not there' — an unreadable ledger ALLOWS, while a missing one refuses", () => {
    const root = fixture.root;
    const script = checklistGateScriptPath(root);
    // A plan root whose parent is a FILE: readdir fails with ENOTDIR, which is not evidence of absence.
    const blocked = path.join(makeTempDir("tachyon-checklist-gate-enotdir-"), "not-a-dir");
    fs.writeFileSync(blocked, "");
    const payload = JSON.stringify({ session_id: SESSION, tool_name: "Edit", tool_input: {} });
    const unreadable = spawnSync("node", [script, "claude", path.join(blocked, "tasks"), "", "reason"], { input: payload, encoding: "utf8" });
    expect(unreadable.status).toBe(0);
    // The same script, against a root that simply has no session directory yet: that IS absence.
    const missing = spawnSync("node", [script, "claude", path.join(makeTempDir("tachyon-checklist-gate-empty-"), "tasks"), "", "reason"], {
      input: payload,
      encoding: "utf8",
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("reason");
  });

  it("a session id that could escape its ledger directory is refused a lookup, and allows", () => {
    const script = checklistGateScriptPath(fixture.root);
    const escape = JSON.stringify({ session_id: "../..", tool_name: "Edit", tool_input: {} });
    expect(spawnSync("node", [script, "claude", claudeTasksRoot(), "", "reason"], { input: escape, encoding: "utf8" }).status).toBe(0);
  });

  it("the refusal is ONE line — grok keeps only the first, so a second line would be lost", () => {
    for (const runtime of ["claude", "codex", "grok"] as const) {
      const refusal = checklistGateRefusal(runtime);
      expect(refusal).not.toContain("\n");
      expect(refusal).toContain("Shell commands count as changes, including reads; the gate applies whenever the required plan is absent.");
      expect(refusal).not.toMatch(/reads.*pass/i);
      expect(refusal).not.toMatch(/first change only/i);
    }
  });
});
