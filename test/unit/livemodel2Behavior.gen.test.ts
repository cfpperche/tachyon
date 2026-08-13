import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityLogWriter } from "../../src/activity/logWriter.js";
import { ActivityLog, LOG_SCHEMA_VERSION } from "../../src/activity/logStore.js";
import { RuntimeOpsSnapshotService, type RuntimeOpsWorkspaceSource } from "../../src/runtimeOps/snapshotService.js";
import { resolveModelFact, toAgentVM, type AgentRaw } from "../../src/sidebar/agentModel.js";
import type { SessionRecord } from "../../src/resume/SessionLedger.js";

/**
 * spec 378 — live model in the sidebar, with honest provenance. End-to-end behavior suite: real transcript
 * bytes -> ActivityLogWriter -> durable per-agent log -> RuntimeOpsSnapshotService's shared projection ->
 * resolveModelFact -> AgentVM, exercising the acceptance scenarios in docs/specs/378-live-model-sidebar/spec.md
 * through the actual pipeline (not mocks) — no pane scraping anywhere in this chain.
 */

const roots: string[] = [];
function freshRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "livemodel2-"));
  roots.push(d);
  return d;
}
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

const claudeLoc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "claude" });
const codexLoc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "codex" });
const grokLoc = (p: string, id: string) => ({ path: p, sessionId: id, runtime: "grok" });

const claudeAssistant = (uuid: string, sid: string, text: string, model: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant", uuid, sessionId: sid, timestamp: "2026-07-13T00:00:00Z", version: "2.1.183",
    isSidechain: false, ...extra,
    message: { role: "assistant", model, content: [{ type: "text", text }] },
  });

const codexTurnContext = (turnId: string, model: string, effort: string) =>
  JSON.stringify({ timestamp: "2026-07-13T00:00:00Z", type: "turn_context", payload: { turn_id: turnId, model, effort } });
const codexAssistantMsg = (id: string, text: string) =>
  JSON.stringify({ timestamp: "2026-07-13T00:00:00Z", type: "response_item", payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] } });
const codexSessionMeta = (id: string, cliVersion: string) =>
  JSON.stringify({ timestamp: "2026-07-13T00:00:00Z", type: "session_meta", payload: { id, cli_version: cliVersion } });
const codexTokenCount = () =>
  JSON.stringify({ timestamp: "2026-07-13T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } });

const grokAssistant = (id: string, text: string, modelId: string) =>
  JSON.stringify({ type: "assistant", id, content: text, model_id: modelId });

/** A minimal RuntimeOpsWorkspaceSource + AgentRaw fixture — matches the shape extension.ts/SidebarPrototype
 *  wire in production, just enough for observedModelFor + resolveModelFact + toAgentVM to run end-to-end. */
function agentRaw(name: string, cmd: string): AgentRaw {
  return { name, cmd, running: true, dead: false, crashed: false };
}
function fleetSource(root: string, agents: Record<string, "claude" | "codex" | "grok">): RuntimeOpsWorkspaceSource {
  const sessions = new Map<string, SessionRecord>(
    Object.entries(agents).map(([name, runtime]) => [name, { cwd: root, lifetime: "saved", resumePolicy: "restartable", updatedAt: "2026-07-13T00:00:00Z", resume: { runtime, sessionId: "s" } }]),
  );
  return { workspaceRoot: root, wsHash: "ws", folderName: "app", ledger: { all: () => sessions } };
}

describe("container-generated delegation behavior", () => {
  // PROTOCOL IDENTIFIER — verify_task checks this exact test name; never rename or remove it. The body is the
  // flagship spec 378 acceptance scenario (in-TUI model switch reaches the sidebar) run through the REAL
  // pipeline end to end; the remaining acceptance scenarios live in the describe block below.
  it("livemodel2Behavior", () => {
    const root = freshRoot();
    const sess = path.join(root, "A.jsonl");
    fs.writeFileSync(sess, claudeAssistant("a1", "A", "hi", "claude-sonnet-5") + "\n");
    const writer = new ActivityLogWriter(path.join(root, "activity"), "worker", () => "2026-07-13T00:00:00Z");
    expect(writer.poll(claudeLoc(sess, "A"))).toBeGreaterThan(0);

    const service = new RuntimeOpsSnapshotService(() => [], {
      activityLog: (r, agent) => new ActivityLog(path.join(r, "activity"), agent),
    });
    const before = service.observedModelFor(root, "ws", "worker");
    expect(resolveModelFact("claude", before)).toMatchObject({ label: "Sonnet 5", source: "observed" });

    // an in-TUI /model switch: the next assistant record lands with a new model id
    fs.appendFileSync(sess, claudeAssistant("a2", "A", "switched", "claude-opus-4-8") + "\n");
    writer.poll(claudeLoc(sess, "A")); // "the next activity poll" — no RuntimeOps webview involved
    const after = service.observedModelFor(root, "ws", "worker");
    const fact = resolveModelFact("claude", after);
    expect(fact).toMatchObject({ label: "Opus 4.8", source: "observed" });
    expect(fact?.observedAt).toBeTruthy();
  });
});

describe("livemodel2Behavior — spec 378 live-model-sidebar acceptance scenarios", () => {
  it("Scenario: pre-first-turn honesty — a freshly spawned agent with no model-bearing record shows declared/profile, never a fake observed", () => {
    const root = freshRoot();
    const service = new RuntimeOpsSnapshotService(() => [], {
      activityLog: (r, agent) => new ActivityLog(path.join(r, "activity"), agent),
    });
    // no transcript written at all yet — the durable log doesn't even exist on disk.
    const observed = service.observedModelFor(root, "ws", "worker");
    expect(observed).toBeUndefined();
    expect(resolveModelFact("codex", observed)).toMatchObject({ label: "Codex default", source: "profile" });
    expect(resolveModelFact("claude --model opus", observed)).toMatchObject({ label: "Opus", source: "declared" });
  });

  it("Scenario: process rotation (restarted) demotes the observed model until a new observation lands", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "A.jsonl");
    fs.writeFileSync(sessA, claudeAssistant("a1", "A", "hi", "claude-opus-4-8") + "\n");
    const writer = new ActivityLogWriter(adir, "worker", () => "2026-07-13T00:00:00Z");
    writer.poll(claudeLoc(sessA, "A"));

    const service = new RuntimeOpsSnapshotService(() => [], { activityLog: (r, agent) => new ActivityLog(path.join(r, "activity"), agent) });
    expect(service.observedModelFor(root, "ws", "worker")).toMatchObject({ id: "claude-opus-4-8" });

    // Tachyon RESTARTS the agent (a process-rotating lifecycle label) — a new session rotates in.
    writer.noteLifecycle("restarted", true);
    const sessB = path.join(root, "B.jsonl");
    fs.writeFileSync(sessB, "");
    writer.poll(claudeLoc(sessB, "B"));

    // demoted — the new process provably reverted to the spawn command; no stale carry-over.
    expect(service.observedModelFor(root, "ws", "worker")).toBeUndefined();
    expect(resolveModelFact("claude", service.observedModelFor(root, "ws", "worker"))).toMatchObject({ label: "Claude default", source: "profile" });
  });

  it("Scenario: process rotation (resumed) is process-PRESERVING — the observation is retained but flagged stale", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sessA = path.join(root, "A.jsonl");
    fs.writeFileSync(sessA, claudeAssistant("a1", "A", "hi", "claude-opus-4-8") + "\n");
    let now = 0;
    const writer = new ActivityLogWriter(adir, "worker", () => "2026-07-13T00:00:00Z", () => now);
    writer.poll(claudeLoc(sessA, "A"));

    // Tachyon RESUMES the agent into the SAME session uuid — no rotation, so the writer emits the boundary
    // standalone after the grace window (STANDALONE_OK covers "resumed").
    writer.noteLifecycle("resumed", true);
    now = 6_000;
    writer.poll(claudeLoc(sessA, "A"));

    const service = new RuntimeOpsSnapshotService(() => [], { activityLog: (r, agent) => new ActivityLog(path.join(r, "activity"), agent) });
    const observed = service.observedModelFor(root, "ws", "worker");
    expect(observed).toMatchObject({ id: "claude-opus-4-8", stale: true });
    expect(resolveModelFact("claude", observed)).toMatchObject({ label: "Opus 4.8", source: "observed", stale: true });
  });

  it("Scenario: divergence is queryable — declared and observed disagree, exposed in the RuntimeOps snapshot and the sidebar row", async () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "rollout.jsonl");
    fs.writeFileSync(sess, [codexSessionMeta("cx", "0.144.0"), codexTurnContext("t1", "gpt-5.6-sol", "high"), codexAssistantMsg("a1", "hi")].join("\n") + "\n");
    new ActivityLogWriter(adir, "worker", () => "2026-07-13T00:00:00Z").poll(codexLoc(sess, "cx"));

    const source = fleetSource(root, { worker: "codex" }) as RuntimeOpsWorkspaceSource & Record<string, unknown>;
    source.manager = {
      listAgents: async () => [{ name: "worker", session: "pane", running: true, lifetime: "saved", resumePolicy: "restartable", dead: false, crashed: false, kind: "agent" as const }],
      defOf: () => ({ cmd: "codex" }), // bare codex → declared "Codex default"
      resumeReadiness: async () => true,
    };
    const service = new RuntimeOpsSnapshotService(() => [source as never], {
      detect: async () => [],
      activityLog: (r, agent) => new ActivityLog(path.join(r, "activity"), agent),
    });

    const snapshot = await service.snapshot();
    const agent = snapshot.runtimes[0].agents[0];
    expect(agent.model).toMatchObject({ value: "Codex default" }); // declared/profile column unchanged (non-goal)
    expect(agent.modelObserved).toMatchObject({ value: "GPT-5.6 Sol", effort: "high" });
    expect(agent.modelDivergence).toBe(true);

    // the SAME fact drives the sidebar row.
    const observed = service.observedModelFor(root, "ws", "worker");
    const vm = toAgentVM(agentRaw("worker", "codex"), { kind: "agent", model: observed });
    expect(vm).toMatchObject({ model: "GPT-5.6 Sol", modelSource: "observed", modelDivergence: true });
  });

  it("Scenario: subagent (isSidechain) records never relabel the primary agent", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "A.jsonl");
    fs.writeFileSync(sess, [
      claudeAssistant("a1", "A", "primary turn", "claude-sonnet-5"),
      claudeAssistant("a2", "A", "sub-agent turn", "claude-haiku-4-5-20251001", { isSidechain: true }),
    ].join("\n") + "\n");
    new ActivityLogWriter(adir, "worker", () => "2026-07-13T00:00:00Z").poll(claudeLoc(sess, "A"));

    const service = new RuntimeOpsSnapshotService(() => [], { activityLog: (r, agent) => new ActivityLog(path.join(r, "activity"), agent) });
    const observed = service.observedModelFor(root, "ws", "worker");
    expect(observed).toMatchObject({ id: "claude-sonnet-5" }); // NOT the sidechain's haiku
  });

  it("Scenario: sidebar updates with RuntimeOps closed — the shared projection cursor advances via the view-independent accessor alone", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "A.jsonl");
    fs.writeFileSync(sess, claudeAssistant("a1", "A", "hi", "claude-sonnet-5") + "\n");
    const writer = new ActivityLogWriter(adir, "worker", () => "2026-07-13T00:00:00Z");
    writer.poll(claudeLoc(sess, "A"));

    const service = new RuntimeOpsSnapshotService(() => [], { activityLog: (r, agent) => new ActivityLog(path.join(r, "activity"), agent) });
    // service.snapshot() is NEVER called anywhere in this test — RuntimeOps was never "opened".
    expect(service.observedModelFor(root, "ws", "worker")).toMatchObject({ id: "claude-sonnet-5" });

    fs.appendFileSync(sess, claudeAssistant("a2", "A", "switched", "claude-opus-4-8") + "\n");
    writer.poll(claudeLoc(sess, "A"));
    expect(service.observedModelFor(root, "ws", "worker")).toMatchObject({ id: "claude-opus-4-8" });
  });

  it("Observed ids missing from the alias table render as the raw/title-cased id, never 'Unavailable'", () => {
    const fact = resolveModelFact("codex", { id: "this-model-definitely-does-not-exist-xyz123", stale: false });
    expect(fact?.label).toBe("This Model Definitely Does Not Exist Xyz123");
    expect(fact?.label).not.toBe("Unavailable");
  });

  it("The normalized vocabulary carries {model, effort?} with NO durable-log schemaVersion bump", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "rollout.jsonl");
    fs.writeFileSync(sess, [codexSessionMeta("cx", "0.144.0"), codexTokenCount(), codexTurnContext("t1", "gpt-5.6-sol", "high"), codexAssistantMsg("a1", "hi")].join("\n") + "\n");
    new ActivityLogWriter(adir, "worker", () => "2026-07-13T00:00:00Z").poll(codexLoc(sess, "cx"));

    const log = new ActivityLog(adir, "worker");
    const events = log.readTail(100);
    expect(events.every((e) => e.schemaVersion === LOG_SCHEMA_VERSION)).toBe(true);
    expect(LOG_SCHEMA_VERSION).toBe(1); // no bump

    const usage = events.find((e) => e.type === "usage.updated");
    expect(usage?.model).toBeUndefined(); // session_meta/token_count never latch a model
    const assistant = events.find((e) => e.type === "assistant.message.completed");
    expect(assistant).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("grok stops smuggling the model id through runtimeVersion — the durable log carries `model`, not a mislabeled `runtimeVersion`", () => {
    const root = freshRoot();
    const adir = path.join(root, "activity");
    const sess = path.join(root, "chat_history.jsonl");
    fs.writeFileSync(sess, grokAssistant("g1", "hi", "grok-4.5") + "\n");
    new ActivityLogWriter(adir, "worker", () => "2026-07-13T00:00:00Z").poll(grokLoc(sess, "grok-session"));

    const log = new ActivityLog(adir, "worker");
    const events = log.readTail(100);
    const assistant = events.find((e) => e.type === "assistant.message.completed");
    expect(assistant?.model).toBe("grok-4.5");
    expect(assistant?.runtimeVersion).toBeUndefined();
  });

  it("AgentVM keeps model:string and gains additive modelSource/modelObservedAt/modelStale/modelDivergence siblings", () => {
    const vm = toAgentVM(agentRaw("worker", "codex"), {
      kind: "agent",
      model: { id: "gpt-5.6-sol", observedAt: "2026-07-13T00:00:00Z", stale: true },
    });
    expect(typeof vm.model).toBe("string");
    expect(vm).toMatchObject({
      model: "GPT-5.6 Sol",
      modelSource: "observed",
      modelObservedAt: "2026-07-13T00:00:00Z",
      modelStale: true,
      modelDivergence: true, // declared "Codex default" vs observed "GPT-5.6 Sol"
    });
  });
});
