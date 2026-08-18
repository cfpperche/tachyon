import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  NOTICE_DRAIN_CODEX_AGENT_ARG,
  NOTICE_DRAIN_MAX_CHARS,
  NOTICE_DRAIN_MAX_NOTICES,
  NOTICE_DRAIN_SCRIPT_SOURCE,
  composeNoticeDrainLine,
  noticeDrainAgentArg,
  noticeDrainScriptPath,
  planNoticeDrainHook,
} from "@tachyon/engine/runtime/noticeDrainHook.js";
import { buildCodexSessionStartHookConfig, buildOwnershipSettings } from "@tachyon/engine/activity/sessionOwners.js";
import { appendDoorbellEvent } from "@tachyon/engine/workspace/doorbell.js";
import { advanceNoticeCursor, ensureNoticeCursorFile, noticeCursorPath, readNoticeCursorFile } from "@tachyon/engine/workspace/noticeCursor.js";

/**
 * t-b47fb2 fatia 2, second half — the end-of-turn drain, exercised through the door PRODUCTION uses.
 *
 * The hook is a bare `node <script>` with the Stop payload on stdin and an exit code as its whole
 * contract, so every case below RUNS it as a subprocess and reads the real exit code and stderr. A
 * test that called a TypeScript function instead would prove nothing about the file the runtimes
 * actually execute (docs/project-guidance.md § "Test through the door PRODUCTION uses").
 *
 * The load-bearing case is the SECOND run: a drain that repeated itself would re-fire on every Stop
 * forever, and grok fires Stop three times per turn (measured 2026-08-18 on 1.0.5).
 */

interface DrainRun {
  code: number;
  stderr: string;
}

function materialize(root: string): string {
  const file = noticeDrainScriptPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, NOTICE_DRAIN_SCRIPT_SOURCE, "utf8");
  return file;
}

function runDrain(root: string, agent: string, opts: { maxNotices?: number; maxChars?: number } = {}): DrainRun {
  const script = noticeDrainScriptPath(root);
  const failureFile = path.join(root, ".tachyon", "activity", "persistence-hooks-failures.jsonl");
  try {
    execFileSync(
      process.execPath,
      [script, agent, root, failureFile, String(opts.maxNotices ?? NOTICE_DRAIN_MAX_NOTICES), String(opts.maxChars ?? NOTICE_DRAIN_MAX_CHARS)],
      { input: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: root }), encoding: "utf8" },
    );
    return { code: 0, stderr: "" };
  } catch (err) {
    const failure = err as { status?: number; stderr?: string };
    return { code: failure.status ?? -1, stderr: failure.stderr ?? "" };
  }
}

function ring(root: string, from: string, to: string, at: string, summary: string, pointer?: string): void {
  appendDoorbellEvent(root, { from, to, at, summary, ...(pointer === undefined ? {} : { pointer }) });
}

describe("t-b47fb2 — the end-of-turn notice drain script", () => {
  it("dumps pending notices, advances the cursor, and does NOT repeat them next turn", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    ring(root, "child", "coord", "2026-08-18T11:00:00.000Z", "t-83d04e done, tree clean", "t-83d04e");
    ring(root, "other", "coord", "2026-08-18T11:05:00.000Z", "gate green");

    const first = runDrain(root, "coord");

    // exit 2 is what puts the text in front of the model on all three measured runtimes.
    expect(first.code).toBe(2);
    expect(first.stderr).toContain("2 notice(s) arrived during your turn");
    expect(first.stderr).toContain("t-83d04e done, tree clean");
    expect(first.stderr).toContain("gate green");
    expect(first.stderr).toContain("[details: t-83d04e]");
    // One line. Grok keeps only the first, so anything past a newline would be delivered nowhere.
    expect(first.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(readNoticeCursorFile(root)?.cursors.coord).toBe("2026-08-18T11:05:00.000Z");

    // THE case this design exists for. Without the cursor advance above, this repeats forever.
    const second = runDrain(root, "coord");
    expect(second).toEqual({ code: 0, stderr: "" });
  });

  it("a notice the engine already delivered is not dumped — the cursor is ONE hand-over record", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    ring(root, "child", "coord", "2026-08-18T11:00:00.000Z", "already delivered into the pane");
    // What `Workspace.deliverNotice` records when it submits into an idle pane.
    advanceNoticeCursor(root, "coord", "2026-08-18T11:00:00.000Z");

    expect(runDrain(root, "coord")).toEqual({ code: 0, stderr: "" });
  });

  it("dumps only what is addressed to THIS agent", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    ring(root, "child", "somebody-else", "2026-08-18T11:00:00.000Z", "not for coord");
    ring(root, "child", "coord", "2026-08-18T11:01:00.000Z", "for coord");

    const run = runDrain(root, "coord");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("for coord");
    expect(run.stderr).not.toContain("not for coord");
    expect(readNoticeCursorFile(root)?.cursors["somebody-else"]).toBeUndefined();
  });

  it("FAIL OPEN: with no cursor file it stays silent rather than dumping the whole trail", () => {
    // The trail is the history of the workspace — 3,291 rows in this one. "Cannot tell pending from
    // history" must answer silence, which is today's behaviour, never "assume everything is pending".
    const root = makeTempDir("notice-drain-");
    materialize(root);
    for (let index = 0; index < 30; index += 1) {
      ring(root, "child", "coord", `2026-08-18T11:${String(index).padStart(2, "0")}:00.000Z`, `notice ${index}`);
    }
    expect(runDrain(root, "coord")).toEqual({ code: 0, stderr: "" });
  });

  it("FAIL OPEN: a corrupt cursor file stays silent", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ring(root, "child", "coord", "2026-08-18T11:00:00.000Z", "pending");
    fs.mkdirSync(path.dirname(noticeCursorPath(root)), { recursive: true });
    for (const corruption of ["{ not json", "[]", '{"version":9}']) {
      fs.writeFileSync(noticeCursorPath(root), corruption, "utf8");
      expect(runDrain(root, "coord"), corruption).toEqual({ code: 0, stderr: "" });
    }
  });

  it("FAIL OPEN: an absent trail stays silent", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    expect(runDrain(root, "coord")).toEqual({ code: 0, stderr: "" });
  });

  it("skips a row with no witnessed summary instead of delivering an empty envelope", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    appendDoorbellEvent(root, { from: "child", to: "coord", at: "2026-08-18T11:00:00.000Z" });
    expect(runDrain(root, "coord")).toEqual({ code: 0, stderr: "" });
  });

  it("one damaged append does not hide the rest of the trail", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    fs.appendFileSync(path.join(root, ".tachyon", "doorbells.jsonl"), '{"to":"coord" truncated\n', "utf8");
    ring(root, "child", "coord", "2026-08-18T11:00:00.000Z", "survives the damaged line");

    const run = runDrain(root, "coord");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("survives the damaged line");
  });

  it("carries at most maxNotices and NAMES the rest — and still advances past all of them", () => {
    // Replaying the overflow next turn would be repetition, not rescue: read_notices reads the same
    // durable trail and the line says so.
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    for (let index = 0; index < 25; index += 1) {
      ring(root, "child", "coord", `2026-08-18T11:${String(index).padStart(2, "0")}:00.000Z`, `notice ${index}`);
    }

    const run = runDrain(root, "coord");
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("20 notice(s) arrived during your turn");
    expect(run.stderr).toContain("5 older notice(s) not carried");
    expect(run.stderr).toContain("read_notices");
    expect(readNoticeCursorFile(root)?.cursors.coord).toBe("2026-08-18T11:24:00.000Z");
    expect(runDrain(root, "coord")).toEqual({ code: 0, stderr: "" });
  });

  it("names what the byte cap cut rather than cutting it silently", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    for (let index = 0; index < 5; index += 1) {
      ring(root, "child", "coord", `2026-08-18T11:0${index}:00.000Z`, "x".repeat(200));
    }

    const run = runDrain(root, "coord", { maxChars: 400 });
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/\(\+\d+ more — read them with read_notices\)/);
    expect(run.stderr.trimEnd().length).toBeLessThan(600);
  });

  it("the script's own composer agrees with the exported one, byte for byte", () => {
    // The script cannot import Tachyon code (a hook runs as a bare `node <file>`), so this is the only
    // thing between two renderings of the same line and a silent drift between them.
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    ring(root, "child", "coord", "2026-08-18T11:00:00.000Z", "first summary", "t-b47fb2");
    ring(root, "sender", "coord", "2026-08-18T11:01:00.000Z", "second summary");

    const run = runDrain(root, "coord");
    expect(run.stderr.trimEnd()).toBe(composeNoticeDrainLine(
      ["[tachyon] child → coord: first summary [details: t-b47fb2]", "[tachyon] sender → coord: second summary"],
      NOTICE_DRAIN_MAX_CHARS,
    ));
  });

  it("collapses a hostile multi-line summary so the dump stays one line", () => {
    const root = makeTempDir("notice-drain-");
    materialize(root);
    ensureNoticeCursorFile(root, "2026-08-18T10:00:00.000Z");
    ring(root, "child", "coord", "2026-08-18T11:00:00.000Z", "line one\nline two\r\nline three");

    const run = runDrain(root, "coord");
    expect(run.code).toBe(2);
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain("line one line two line three");
  });
});

describe("t-b47fb2 — which runtimes the drain reaches, and on which channel", () => {
  const input = {
    scriptPath: "/ws/.tachyon/activity/notice-drain.cjs",
    workspaceRoot: "/ws",
    failureFile: "/ws/.tachyon/activity/persistence-hooks-failures.jsonl",
    agentArg: noticeDrainAgentArg("coord"),
  };

  it("reaches exactly the three runtimes whose Stop channel was measured", () => {
    for (const runtime of ["claude", "codex", "grok"]) {
      expect(planNoticeDrainHook(runtime, input)?.hooks[0]?.command, runtime).toContain("notice-drain.cjs");
    }
    // Named rather than silently missing: no measured channel means no claim of one.
    for (const runtime of ["pi", "opencode", "hermes", "gemini", "qwen"]) {
      expect(planNoticeDrainHook(runtime, input), runtime).toBeUndefined();
    }
  });

  it("emits statusMessage only for codex — the grok adapter parser rejects the key outright", () => {
    expect(planNoticeDrainHook("codex", input)?.hooks[0]?.statusMessage).toBe("Draining Tachyon notices");
    expect(planNoticeDrainHook("claude", input)?.hooks[0]?.statusMessage).toBeUndefined();
    expect(planNoticeDrainHook("grok", input)?.hooks[0]?.statusMessage).toBeUndefined();
  });

  it("claude and grok bake the agent name; codex resolves it from the environment", () => {
    expect(planNoticeDrainHook("claude", input)?.hooks[0]?.command).toContain("'coord'");
    expect(planNoticeDrainHook("codex", { ...input, agentArg: NOTICE_DRAIN_CODEX_AGENT_ARG })?.hooks[0]?.command)
      .toContain('"$TACHYON_AGENT_NAME"');
  });

  it("rides the lifecycle Stop channel as its OWN group, beside the bookkeeping hooks", () => {
    // Its contract is the opposite of theirs: they must never block, this one exits 2 whenever a
    // notice is pending. Sharing a group would make a legitimate refusal read as a recorder failure.
    const drain = planNoticeDrainHook("claude", input)!;
    const settings = buildOwnershipSettings(
      "/ws/recorder.cjs",
      "coord",
      "/ws/owners.jsonl",
      undefined,
      undefined,
      { noticeDrain: drain },
      { publisherPath: "/ws/publish.cjs", runtime: "claude" },
    );
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop?.[1]).toEqual(drain);
    expect(JSON.stringify(settings.hooks.Stop?.[0])).not.toContain("notice-drain");
  });

  it("is installed even when silent persistence is off — delivery is not bookkeeping", () => {
    const drain = planNoticeDrainHook("grok", input)!;
    const settings = buildOwnershipSettings("/ws/recorder.cjs", "coord", "/ws/owners.jsonl", undefined, undefined, { noticeDrain: drain });
    expect(settings.hooks.Stop).toEqual([drain]);
  });

  it("codex carries both Stop groups in ONE -c override, because a second would replace the first", () => {
    const drain = planNoticeDrainHook("codex", { ...input, agentArg: NOTICE_DRAIN_CODEX_AGENT_ARG })!;
    const rendered = buildCodexSessionStartHookConfig(
      "/ws/recorder.cjs",
      "/ws/owners.jsonl",
      undefined,
      { stopRecorderPath: "/ws/stop.cjs", stopFile: "/ws/stop.jsonl", failureFile: "/ws/fail.jsonl" },
      undefined,
      "/ws/publish.cjs",
      undefined,
      drain,
    );
    const stopKeys = (Array.isArray(rendered) ? rendered : [rendered]).filter((entry) => entry.startsWith("hooks.Stop="));
    expect(stopKeys).toHaveLength(1);
    expect(stopKeys[0]).toContain("notice-drain.cjs");
    expect(stopKeys[0]).toContain("stop.cjs");
  });

  it("codex still gets a Stop override when it is the ONLY thing on that channel", () => {
    const drain = planNoticeDrainHook("codex", { ...input, agentArg: NOTICE_DRAIN_CODEX_AGENT_ARG })!;
    const rendered = buildCodexSessionStartHookConfig("/ws/recorder.cjs", "/ws/owners.jsonl", undefined, undefined, undefined, undefined, undefined, drain);
    const stopKeys = (Array.isArray(rendered) ? rendered : [rendered]).filter((entry) => entry.startsWith("hooks.Stop="));
    expect(stopKeys).toHaveLength(1);
    expect(stopKeys[0]).toContain("notice-drain.cjs");
  });
});

describe("t-b47fb2 — composeNoticeDrainLine", () => {
  it("keeps everything that fits and names the rest", () => {
    expect(composeNoticeDrainLine(["a", "b"], 1000)).toBe("[tachyon] 2 notice(s) arrived during your turn: a · b");
    expect(composeNoticeDrainLine(["a".repeat(50), "b".repeat(50)], 60))
      .toBe(`[tachyon] 2 notice(s) arrived during your turn: (+2 more — read them with read_notices)`);
  });

  it("says nothing about dropping when nothing was dropped", () => {
    expect(composeNoticeDrainLine(["only"], NOTICE_DRAIN_MAX_CHARS)).not.toContain("more —");
    expect(NOTICE_DRAIN_MAX_NOTICES).toBe(20);
  });
});
