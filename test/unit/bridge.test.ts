import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge, derivePort, DERIVED_PORT_BASE, DERIVED_PORT_SPAN, type BridgeRequestCompleteInfo } from "../../src/bridge/Bridge.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxQueueError, TmuxService, sessionName, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { PinAttachmentStore } from "../../src/pins/PinAttachmentStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { wakeTaskAssignee } from "../../src/tasks/taskNotificationPolicy.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { ContinuityStore } from "../../src/continuity/ContinuityStore.js";
import { ProjectHandoffStore } from "../../src/handoff/ProjectHandoffStore.js";
import { validateCompleteNode } from "../../src/pipeline/completeNode.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { EVIDENCE_SCHEMA_VERSION, isSafeArtifactRef, viewEvidence, summarizeEvidence, type WorktreeEvidence } from "../../src/worktree/evidence.js";
import type { ChangedFile } from "../../src/worktree/review.js";
import { readDoorbellEvents } from "../../src/bridge/doorbell.js";
import { projectRuntimeCondition, NO_QUOTA_CHANNEL } from "../../src/runtimeOps/runtimeCondition.js";
import type { NoticeSourceMetadata } from "../../src/bridge/tools.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";

/**
 * True end-to-end: a real MCP client (the official SDK) talking streamable-HTTP to a
 * real Bridge over loopback — only tmux itself is faked at the executor level.
 */

// t-eb4b30 — a REAL directory, because this suite's AgentManager now needs a working SessionLedger: a
// Temporary agent's definition is its ledger row, so the ad-hoc spawn/dismiss/list tools below have
// nowhere to read from without one. It used to be the string "/repo", which was enough only while a
// private in-memory map held those definitions instead.
const WS = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tachyon-bridge-ws-"));
const HASH = workspaceHash(WS);

function fakeTmuxExec() {
  const sessions = new Map<string, string>(); // name -> last input
  const launches = new Map<string, string[]>(); // name -> new-session argv
  const dead = new Map<string, number>(); // name -> exit code
  const panes = new Map<string, string>(); // name -> visible/captured pane text
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      sessions.set(name, "");
      launches.set(name, [...args]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        dead.delete(target());
        panes.delete(target());
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions.keys()].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions.keys()].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n"), stderr: "" };
      case "capture-pane":
        if (!sessions.has(target())) throw new Error("can't find session");
        {
          if (panes.get(target()) === "__THROW__") throw new Error("capture failed");
          // Managed non-Codex runtimes now require a positive composer affordance before the
          // Bridge reports ready. A bare Claude-shaped prompt is realistic for these shared
          // fixtures and remains insufficient for Codex, whose classifier also requires a footer.
          const raw = panes.get(target()) ?? `$ fake output for ${target()}\n> \n`;
          const start = args.indexOf("-S");
          if (start >= 0) {
            const n = Math.abs(Number(args[start + 1]));
            return { stdout: raw.split("\n").slice(-n).join("\n"), stderr: "" };
          }
          return { stdout: raw, stderr: "" };
        }
      case "send-keys": {
        if (args.includes("-l")) sessions.set(target(), args[args.length - 1]);
        return { stdout: "", stderr: "" };
      }
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, launches, dead, panes, exec };
}

describe("Bridge end-to-end over streamable HTTP", () => {
  // t-e88c8a stage 1 — 78 → 69. The nine Delivery tools are gone: the seven git_delivery_*/delivery_*
  // plus verify_task ("Requires delivery_id") and wait_for_lease, which had no subject without the
  // lease. This list IS the inventory guard — a reintroduced tool fails here by name.
  // t-f638bd — 69 → 70: reconcile_task, the verb for recording an outcome that already happened.
  // t-0bebf6 — 70 → 71: acknowledge_agent, the fifth exit on the host's idle poke ("I already decided").
  // t-6f0377 — 71 → 72: renew_context, the agent's own compact/fresh verb.
  // t-afe120 — 72 → 75: propose/list/cancel_saved_agent_removal_proposal (governed Saved Agent retirement).
  // t-458497 — 75 → 76: runtime_condition, the two-axis read on what condition each runtime is in.
  // t-14cf7c — 76 → 77: explicit, name-scoped orphan runtime credential reconciliation.
  // t-a4ac02 — 77 → 76: next_task Bridge tool removed (function nextTask() still powers MC spotlight).
  // t-75e9c7 — 76 → 77: agent_touched_files, the worktree-diff read that replaces the coordinator's
  // hand-written "who's touching what" list.
  // t-167b5c — 77 → 78: read_notices, the durable read door onto .tachyon/doorbells.jsonl (spec 493).
  it("exposes exactly the 78 canonical tools, including the explicit Terminal operation", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "acknowledge_agent",
      "agent_touched_files",
      "append_project_handoff_note",
      "append_task_note",
      "attach_evidence",
      "attach_task_prototype",
      "cancel_human_approval",
      "cancel_saved_agent_proposal",
      "cancel_saved_agent_removal_proposal",
      "clear_human_flag",
      "close_validation",
      "complete_node",
      "complete_pin",
      "continue_task",
      "continuity_status",
      "create_pin",
      "create_task",
      "create_validation",
      "create_worktree",
      "discover_validation_candidates",
      "dismiss_agent",
      "flag_for_human",
      "get_approval_status",
      "get_continuity",
      "get_pin",
      "get_project_handoff",
      "get_task",
      "get_validation",
      "get_worktree",
      "kill_agent",
      "list_agents",
      "list_commands",
      "list_evidence",
      "list_pending_approvals",
      "list_pins",
      "list_saved_agent_proposals",
      "list_saved_agent_removal_proposals",
      "list_schedules",
      "list_tasks",
      "list_validations",
      "list_worktrees",
      "next_validation",
      "notify",
      "notify_agent",
      "propose_saved_agent",
      "propose_saved_agent_removal",
      "propose_schedule",
      "read_notices",
      "read_output",
      "reanchor_agent",
      "reconcile_runtime_credentials",
      "reconcile_task",
      "reconcile_worktree_hygiene",
      "register_worktree",
      "remove_worktree",
      "renew_context",
      "request_human_approval",
      "request_human_attention",
      "restart_agent",
      "run_command",
      "run_host_action",
      "run_runbook",
      "runtime_condition",
      "set_continuity",
      "set_project_handoff",
      "spawn_agent",
      "spawn_terminal",
      "submit_evolution_review",
      "unregister_worktree",
      "update_pin",
      "update_task",
      "update_validation",
      "verify_agent",
      "wait_for_agent",
      "wait_for_output",
      "worktree_hygiene",
      "write_input",
      "write_tachyon_config",
    ]);
  });

  // Legacy generated guard: it("exposes exactly the 60 tools (17 agent ...")
  const { sessions, launches, dead, panes, exec } = fakeTmuxExec();
  const notifications: Array<{ message: string; level: string }> = [];
  const config = parseConfig("agents:\n  claude:\n    cmd: claude\nsettings:\n  maxAgents: 2\n").config;
  const tmux = new TmuxService(exec);
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    ledger: new SessionLedger(WS),
    getConfig: () => config,
    launchPreflight: {
      check: async (command) => command.model === "missing-model"
        ? { state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: command.model, suggestions: ["gpt-5.6-sol"] }
        : { state: "supported", runtime: "fixture", source: "fixture" },
    },
  });
  const pinsRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tachyon-bridge-pins-"));
  const pins = new PinStore(pinsRoot);
  // t-57a00a — the assignee wake-up hangs off the store's mutation sink now, not off the Bridge's
  // update_task handler, so the four UI writers get it too. In production Workspace wires this and the
  // Bridge only receives the already-wired store; this harness builds its own, so it wires it the same
  // way. `notifyAssignee` is assigned below, next to the deps that own delivery.
  let notifyAssignee: ((target: string, line: string) => Promise<unknown>) | undefined;
  const tasks = new TaskStore(pinsRoot, {
    onMutation: async (event) => { await wakeTaskAssignee(event, {
      // t-c3c0c2 — the liveness gate is no longer re-typed here. This harness used to carry its own
      // copy, and the first version omitted the has-session check: the fake tmux then MINTED a session
      // row for a name that never had one, and eighteen later scenarios read that ghost as a live agent.
      isLiveAgent: async (name) => manager.kindOf(name) === "agent" && tmux.hasSession(manager.session(name)),
      deliver: (target, line) => notifyAssignee?.(target, line) ?? Promise.resolve(),
    }); },
  });
  const validations = new ValidationStore(pinsRoot);
  const continuity = new ContinuityStore(pinsRoot);
  const handoff = new ProjectHandoffStore(pinsRoot);
  const verifyRuns: string[] = [];
  let taskChanges = 0;
  let noticeMode: "immediate" | "queued" = "immediate";
  let deliveredNoticeMetadata: NoticeSourceMetadata | undefined;
  // t-8605be — "claude"'s attention is mutable so tests can flip it between needs-input (the default,
  // relied on by other suites below: list_agents attention + wait_for_agent) and a genuinely-busy state
  // to exercise write_input's refusal path without disturbing those other tests.
  let claudeAttention: "working" | "idle" | "needs-input" | "throttled" = "needs-input";
  let claudeComposerOccupied = false;
  // t-75e9c7 — agent_touched_files' git port, keyed by worktree cwd; empty by default (no fixture
  // wires deps.agentWorktrees here, so every live agent hits the honest "no isolated worktree"
  // branch — the real diff-vs-baseRef behaviour is proven with real git in worktree.integration.test.ts).
  const touchedFilesByCwd: Record<string, ChangedFile[]> = {};
  // t-a53dd9 — the SAME question answered from the pane instead of from the poll. Independent of
  // `claudeComposerOccupied` on purpose: the incident is exactly the case where the two disagree.
  let claudeComposerDraftNow: boolean | undefined = undefined;
  // spec 273 — back the evidence channel with a REAL SessionLedger (a worktree-backed "claude"),
  // wiring attach/list exactly as Workspace does (a fixed HEAD stands in for git). Headless dogfood.
  const evRoot = makeTempDir("tachyon-bridge-ev-");
  const evLedger = new SessionLedger(evRoot);
  evLedger.record("claude", { def: { cmd: "claude", kind: "agent" }, worktree: { path: "/wt/claude", branch: "b", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t0" }, cwd: "/wt/claude", instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true } });
  const EV_HEAD = "abc123";
  let evSeq = 0;
  let validationChanges = 0;
  let activitySeq = 7;
  const hostActionCalls: unknown[] = [];
  const bridge = new Bridge({
    workspaceRoot: pinsRoot,
    manager,
    tmux,
    pins,
    tasks,
    validations,
    continuity,
    handoff,
    lastActivityAt: () => null,
    currentActivitySeq: () => activitySeq,
    notify: (message, level) => notifications.push({ message, level }),
    onTasksChanged: () => { taskChanges += 1; },
    onValidationsChanged: () => { validationChanges += 1; },
    attentionOf: (agent) => (agent === "claude" ? claudeAttention : undefined),
    composerOccupiedOf: (agent) => (agent === "claude" ? claudeComposerOccupied : undefined),
    composerDraftNow: async (agent) => (agent === "claude" ? claudeComposerDraftNow : undefined),
    deliverNotice: async (target, line, metadata) => {
      deliveredNoticeMetadata = metadata;
      if (noticeMode === "queued") return { status: "queued", queued: 1 };
      await tmux.sendSubmittedLine(manager.session(target), line, { delayMs: 0 });
      return { status: "notified" };
    },
    authoredNoticeMetadata: (agent: string) => ({ origin: "agent-authored" as const, sourceChild: agent, sourceIncarnation: 7 }),
    // spec 214 — claude is a worktree agent with a verified-but-now-stale gate; others have none.
    // spec 273 — fold the evidence summary into the handoff (additive).
    verifyInfo: async (agent) =>
      agent === "claude"
        ? {
            command: "npm test",
            passed: true,
            atCommit: "abc123",
            ranAt: "2026-06-14T00:00:00Z",
            stale: true,
            evidence: evLedger.getEvidence(agent).length ? summarizeEvidence(evLedger.getEvidence(agent), EV_HEAD) : undefined,
          }
        : undefined,
    // t-75e9c7 — agent_touched_files' worktree-diff read; no deps.agentWorktrees ledger is wired in
    // this harness, so every live agent falls into the honest no-worktree branch.
    touchedFiles: async (cwd) => touchedFilesByCwd[cwd] ?? [],
    // spec 273 — the evidence channel deps (mirror Workspace.attachEvidence/listEvidence; fixed HEAD for git).
    attachEvidence: async (input) => {
      if (!evLedger.get(input.targetAgent)?.worktree) return { ok: false, reason: "no worktree" };
      if (input.producer === "verify") return { ok: false, reason: "producer 'verify' is reserved" };
      const bad = (input.artifacts ?? []).find((a) => !isSafeArtifactRef(a));
      if (bad) return { ok: false, reason: `unsafe artifact ref rejected: ${bad}` };
      const id = `ev-${evSeq++}`;
      const record: WorktreeEvidence = {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        id,
        targetAgent: input.targetAgent,
        producer: input.producer,
        atCommit: EV_HEAD,
        producedAt: `2026-06-27T00:00:${String(evSeq).padStart(2, "0")}Z`,
        kind: input.kind,
        severity: input.severity,
        summary: input.summary,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.data ? { data: input.data } : {}),
        ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
      };
      evLedger.appendEvidence(input.targetAgent, record);
      return { ok: true, id };
    },
    listEvidence: async (agent) => viewEvidence(evLedger.getEvidence(agent), EV_HEAD),
    runVerify: async (agent) => {
      verifyRuns.push(agent);
      // spec 273 — the real Workspace.runVerify folds the evidence summary into the handoff; mirror it.
      const ev = evLedger.getEvidence(agent);
      return { command: "npm test", passed: true, atCommit: "def456", ranAt: "2026-06-14T01:00:00Z", stale: false, evidence: ev.length ? summarizeEvidence(ev, EV_HEAD) : undefined };
    },
    // spec 230 — a tiny in-test run registry: run-1/implement is running with a known nonce.
    completeNode: async (input) =>
      validateCompleteNode(input, (rid, nid) =>
        rid === "run-1" && nid === "implement" ? { nonce: "secret-123", status: "running", alreadySignalled: false } : null,
      ),
    // t-458497 — the derived runtime-condition projection, built from the same registries the product
    // reads, with a synthetic quota channel inventory: codex has a control-plane source, claude has a
    // rendered-surface one, and grok deliberately has NONE.
    runtimeCondition: () =>
      projectRuntimeCondition({
        generatedAt: "2026-08-02T18:00:00.000Z",
        channels: [
          { provider: "codex", source: "cli", channel: { acquisition: "control-plane", mechanism: "app-server" } },
          { provider: "claude", source: "cli", channel: { acquisition: "rendered-surface", mechanism: "status line" } },
        ],
        preferences: {
          codex: { scope: { kind: "provider-account", provider: "codex", key: "ps_0123456789abcdef" }, sources: ["cli"] },
          claude: { scope: { kind: "provider-account", provider: "claude", key: "ps_fedcba9876543210" }, sources: ["cli"] },
        },
        observations: {
          claude: {
            schemaVersion: 1,
            collector: { id: "fixture", version: "1.0.0" },
            generatedAt: "2026-08-02T18:00:00.000Z",
            facts: [{
              kind: "provider-quota",
              scope: { kind: "provider-account", provider: "claude", key: "ps_fedcba9876543210" },
              source: "cli",
              confidence: "exact",
              observedAt: "2026-08-02T17:59:00.000Z",
              freshness: { state: "fresh" },
              windows: [{ name: "session", usedPercent: 12, windowMinutes: 300, resetsAt: "2026-08-02T22:00:00.000Z" }],
            }],
            diagnostics: [],
          },
        },
      }),
    runHostAction: async (input) => {
      hostActionCalls.push(input);
      return {
        ok: false,
        code: "result_unknown",
        message: "mock host action result is unknown",
        actionId: "act-bridge",
        auditSeq: 1,
        outcomeSeq: 2,
      };
    },
  });
  // t-57a00a — delivery for the store's sink, mirroring the deps' `deliverNotice` above: `queued` means
  // the notice is held for idle, which for these tests is "the pane must not have received it".
  // t-c3c0c2 — delivery ONLY; the liveness gate moved into the composed effect and is no longer
  // this harness's to get right. `queued` means the notice is held for idle, which for these tests is
  // "the pane must not have received it".
  notifyAssignee = async (target, line) => {
    if (noticeMode === "queued") return;
    await tmux.sendSubmittedLine(manager.session(target), line, { delayMs: 0 });
  };
  let client: Client;
  let toolListChanged: Array<string[]> = [];
  let resolveToolListChanged: (() => void) | undefined;

  beforeAll(async () => {
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    client = new Client(
      { name: "test-agent", version: "0.0.1" },
      {
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (!error && tools) toolListChanged.push(tools.map((t) => t.name).sort());
              resolveToolListChanged?.();
            },
          },
        },
      },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!)));
  });

  afterAll(async () => {
    await client.close();
    await bridge.dispose();
    fs.rmSync(pinsRoot, { recursive: true, force: true });
  });



  it("run_host_action uses the Bridge-resolved caller and never accepts caller as a parameter", async () => {
    hostActionCalls.length = 0;
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "run_host_action");
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("caller");
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("agent");

    const res = await client.callTool({ name: "run_host_action", arguments: { action: "reloadWindow" } });
    const content = res.content as Array<{ type: "text"; text: string }>;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: false, code: "result_unknown", actionId: "act-bridge" });
    expect(hostActionCalls).toEqual([
      {
        action: "reloadWindow",
        caller: { kind: "legacy" },
      },
    ]);
  });






  // t-458497 — the read door. An agent deciding where to send work asks over the Bridge and gets the
  // two axes SEPARATED, with the absence of a quota channel stated by name instead of implied.
  it("runtime_condition answers both axes over the Bridge and names a missing quota channel", async () => {
    const all = await client.callTool({ name: "runtime_condition", arguments: {} });
    const report = JSON.parse((all.content as Array<{ text: string }>)[0].text);
    expect(report.axes.configuration).toBeTruthy();
    expect(report.axes.capacity).toBeTruthy();

    const grok = await client.callTool({ name: "runtime_condition", arguments: { runtime: "grok" } });
    const one = JSON.parse((grok.content as Array<{ text: string }>)[0].text);
    expect(one.runtimes).toHaveLength(1);
    // Manageable and measured on the configuration axis...
    expect(one.runtimes[0].configuration.manageable.state).toBe("manageable");
    expect(one.runtimes[0].configuration.measured.state).toBe("measured");
    // ...and, on the capacity axis, an absence said by name rather than a zero.
    expect(one.runtimes[0].capacity.channel).toMatchObject({ state: "absent", says: NO_QUOTA_CHANNEL });
    expect(one.runtimes[0].capacity.quota).toMatchObject({ state: "no-quota-channel", says: NO_QUOTA_CHANNEL });
    expect(JSON.stringify(one.runtimes[0].capacity)).not.toContain("usedPercent");

    // The fragile channel is labelled, not silently equated with the firm one.
    const claude = await client.callTool({ name: "runtime_condition", arguments: { runtime: "claude" } });
    const quota = JSON.parse((claude.content as Array<{ text: string }>)[0].text).runtimes[0].capacity;
    expect(quota.channel).toMatchObject({ acquisition: "rendered-surface", integrity: "best-effort" });
    expect(quota.quota).toMatchObject({ state: "observed", integrity: "best-effort" });
    expect(quota.quota.windows[0]).toMatchObject({ usedPercent: 12, resetsAt: "2026-08-02T22:00:00.000Z" });

    // Every field names where it came from — the projection authors no runtime list of its own.
    const codex = JSON.parse(
      ((await client.callTool({ name: "runtime_condition", arguments: { runtime: "codex" } })).content as Array<{ text: string }>)[0].text,
    ).runtimes[0];
    expect(codex.configuration.manageable.origin.registry).toBe("SUPPORTED_AGENT_RUNTIMES");
    expect(codex.configuration.measured.origin.registry).toBe("RUNTIME_NATIVE_MEMORY_REGISTRY");

    const missing = await client.callTool({ name: "runtime_condition", arguments: { runtime: "nope" } });
    expect(missing.isError).toBe(true);
  });

  it("emits notifications/tools/list_changed to established MCP sessions", async () => {
    const changed = new Promise<void>((resolve, reject) => {
      resolveToolListChanged = resolve;
      setTimeout(() => reject(new Error("timed out waiting for tools/list_changed")), 1000);
    });

    bridge.announceToolListChanged();

    await changed;
    expect(toolListChanged.at(-1)).toContain("append_task_note");
  });


  it("pins tools round-trip through MCP onto the workspace files", async () => {
    const created = await client.callTool({ name: "create_pin", arguments: { text: "flaky test found", tags: ["Bug", "needs review"], agent: "claude" } });
    expect(created.isError).toBeFalsy();
    const id = /p-[0-9a-f]{6}/.exec(JSON.stringify(created.content))?.[0];
    expect(id).toBeTruthy();

    const listed = await client.callTool({ name: "list_pins", arguments: {} });
    const pinsJson = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
    expect(pinsJson.find((p: { id: string }) => p.id === id)).toMatchObject({ id, text: "flaky test found", tags: ["bug", "needs-review"], by: "claude", done: false });
    // the file door agrees with the tool door
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "pins.json"), "utf8")).toContain("flaky test found");

    await client.callTool({ name: "complete_pin", arguments: { id } });
    expect(pins.list().find((p) => p.id === id)?.done).toBe(true);

    const updated = await client.callTool({ name: "update_pin", arguments: { id, tags: ["docs"] } });
    expect(updated.isError).toBeFalsy();
    expect(pins.list().find((p) => p.id === id)?.tags).toEqual(["docs"]);

    const bad = await client.callTool({ name: "complete_pin", arguments: { id: "p-ffffff" } });
    expect(bad.isError).toBe(true);
  });

  it("create_pin keeps agent-created long findings out of the sidebar title", async () => {
    const longFinding = [
      "Investigate notify_agent envelope submit flakiness: the host types the [tachyon] envelope but the recipient sometimes does not start a turn.",
      "",
      "Observed while dogfooding the bridge tools. Keep the full context in the pin detail so another agent can resume without turning the sidebar into a wall of text.",
    ].join("\n");

    const created = await client.callTool({ name: "create_pin", arguments: { text: longFinding, tags: ["Bug"], agent: "codex" } });
    expect(created.isError).toBeFalsy();
    const id = /p-[0-9a-f]{6}/.exec(JSON.stringify(created.content))![0];

    const listed = await client.callTool({ name: "list_pins", arguments: {} });
    const pin = JSON.parse((listed.content as Array<{ text: string }>)[0].text).find((p: { id: string }) => p.id === id);
    expect(pin).toMatchObject({ id, by: "codex", detail: true, tags: ["bug"] });
    expect(pin.text).toBe("Investigate notify_agent envelope submit flakiness: the host types the [tachyon] envelope but the recipient sometimes...");
    expect(pin.text).not.toContain("Observed while dogfooding");

    const detail = JSON.parse(((await client.callTool({ name: "get_pin", arguments: { id } })).content as Array<{ text: string }>)[0].text);
    expect(detail.detail).toBe(true);
    expect(detail.doc.content[0].content[0].text).toContain("Investigate notify_agent envelope submit flakiness");
    expect(detail.doc.content[1].content[0].text).toContain("Observed while dogfooding");
  });

  it("create_pin accepts explicit title and detail without duplicating the body", async () => {
    const created = await client.callTool({
      name: "create_pin",
      arguments: {
        title: "Tool pins need concise titles",
        detail: "Full context for the pin lives here.\nIt can be multiline.",
        agent: "claude",
      },
    });
    expect(created.isError).toBeFalsy();
    const id = /p-[0-9a-f]{6}/.exec(JSON.stringify(created.content))![0];
    const detail = JSON.parse(((await client.callTool({ name: "get_pin", arguments: { id } })).content as Array<{ text: string }>)[0].text);
    expect(detail.summary).toMatchObject({ text: "Tool pins need concise titles", detail: true });
    expect(detail.doc.content[0].content.map((n: { type: string; text?: string }) => n.type === "hardBreak" ? "\n" : n.text).join("")).toBe("Full context for the pin lives here.\nIt can be multiline.");
  });

  it("get_pin returns rich local detail or summary-only legacy shape without binary payloads", async () => {
    const legacy = pins.create("legacy detail", "claude");
    const legacyResult = await client.callTool({ name: "get_pin", arguments: { id: legacy.id } });
    const legacyParsed = JSON.parse((legacyResult.content as Array<{ text: string }>)[0].text);
    expect(legacyParsed).toMatchObject({ detail: false, doc: null, attachments: [] });
    expect(legacyParsed.summary).toMatchObject({ id: legacy.id, text: "legacy detail", detail: false });

    const blobs = new PinAttachmentStore(pinsRoot);
    const att = blobs.putImage({ data: Buffer.from("bridge-image"), mediaType: "image/png", source: "paste", name: "bridge.png" });
    const rich = pins.createRich("rich detail", "human", { doc: { type: "doc", content: [] }, attachments: [att], now: "2026-06-24T00:00:00.000Z" });
    const richResult = await client.callTool({ name: "get_pin", arguments: { id: rich.id } });
    const raw = (richResult.content as Array<{ text: string }>)[0].text;
    expect(raw).not.toMatch(/base64|data:image/);
    const richParsed = JSON.parse(raw);
    expect(richParsed).toMatchObject({ detail: true, doc: { type: "doc", content: [] } });
    expect(richParsed.summary).toMatchObject({ id: rich.id, detail: true, attachmentCount: 1 });
    expect(richParsed.attachments[0]).toMatchObject({ id: att.id, path: `.tachyon/pins/blobs/${att.blobRef}`, available: true });

    const sketch = blobs.putExcalidraw({
      sceneJson: JSON.stringify({ type: "excalidraw", elements: [{ id: "el-1", type: "rectangle" }], appState: {}, files: {} }),
      previewData: Buffer.from("preview"),
      source: "blank",
    });
    const withSketch = pins.createRich("sketch detail", "human", {
      doc: { type: "doc", content: [{ type: "tachyonSketch", attrs: { attachmentId: sketch.id } }] },
      attachments: [sketch],
      now: "2026-06-24T00:01:00.000Z",
    });
    const sketchRaw = ((await client.callTool({ name: "get_pin", arguments: { id: withSketch.id } })).content as Array<{ text: string }>)[0].text;
    expect(sketchRaw).not.toMatch(/base64|data:image|sceneJson|previewBase64/);
    const sketchParsed = JSON.parse(sketchRaw);
    expect(sketchParsed.attachments[0]).toMatchObject({
      kind: "excalidraw",
      scenePath: `.tachyon/pins/blobs/${sketch.sceneBlobRef}`,
      sceneAvailable: true,
      previewPath: `.tachyon/pins/blobs/${sketch.previewBlobRef}`,
      previewAvailable: true,
    });

    const missing = await client.callTool({ name: "get_pin", arguments: { id: "p-ffffff" } });
    expect(missing.isError).toBe(true);
  });

  it("task tools round-trip through MCP with bounded list and CAS claim", async () => {
    const created = await client.callTool({
      name: "create_task",
      arguments: {
        title: "Build queue entity",
        body: "Full implementation detail",
        kind: "feature",
        artifact_refs: [{ type: "linear", ref: "ENG-42" }],
        agent: "claude",
      },
    });
    expect(created.isError).toBeFalsy();
    // t-f638bd — create_task answers with a receipt: the minted id, the lane, the Bridge-resolved author
    // and the timestamp. The title went out in the request; it comes back from get_task, below.
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    expect(task).toMatchObject({ author: "claude", status: "inbox" });
    expect(task.id).toMatch(/^t-[0-9a-f]{6}$/);
    expect(task.title).toBeUndefined();

    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged", priority: 1, rank: "a" } });
    const listed = await client.callTool({ name: "list_tasks", arguments: { limit: 10 } });
    const summaries = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
    expect(summaries[0]).toMatchObject({ id: task.id, priority: 1, rank: "a" });
    expect(summaries[0].body).toBeUndefined();

    // t-a4ac02 — next_task tool removed; CAS claim is the agent-facing claim path (or spawn_agent claim_task:).
    const claimed = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "codex", expect: { assignee: null } } });
    expect(claimed.isError).toBeFalsy();

    const active = await client.callTool({ name: "update_task", arguments: { id: task.id, status: "active" } });
    expect(active.isError).toBeFalsy();

    const done = await client.callTool({ name: "update_task", arguments: { id: task.id, status: "done" } });
    expect(done.isError).toBeFalsy();

    const reopened = await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    expect(reopened.isError).toBeFalsy();

    const loser = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude", expect: { assignee: null } } });
    expect(loser.isError).toBe(true);
    expect((loser.content as Array<{ text: string }>)[0].text).toContain("precondition-failed");

    const full = await client.callTool({ name: "get_task", arguments: { id: task.id } });
    const fullParsed = JSON.parse((full.content as Array<{ text: string }>)[0].text);
    expect(fullParsed.task).toMatchObject({ id: task.id, body: "Full implementation detail", status: "triaged", assignee: "codex" });
    // t-f33480 — each status move journals author + reason (this path has no agent caller → "human").
    expect(fullParsed.journal.map((e: { author: string; text: string }) => [e.author, e.text])).toEqual([
      ["human", "status inbox -> triaged; priority none -> 1"],
      ["human", "status triaged -> active"],
      ["human", "status active -> done"],
      ["human", "status done -> triaged"],
    ]);
    // t-ab7708 — the window declares what came back so "nothing" never has to be guessed at.
    expect(fullParsed.journalWindow).toMatchObject({ mode: "tail", returned: 4, total: 4, truncated: false });
    expect(taskChanges).toBeGreaterThanOrEqual(3);
  });

  it("get_task windows the journal by bytes, declares what it withheld, and hands back the whole log on request", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "journal cost", agent: "claude" } });
    const { id } = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    for (let i = 0; i < 20; i++) {
      tasks.journal.append(id, { author: "claude", text: `entry ${i} ${"z".repeat(700)}`, now: `2026-08-02T00:00:${String(i).padStart(2, "0")}.000Z` });
    }
    const read = async (args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name: "get_task", arguments: { id, ...args } })).content as Array<{ text: string }>)[0].text);

    // Default: bounded, newest-first, and never quiet about it.
    const tail = await read({});
    expect(tail.journal.length).toBeGreaterThan(0);
    expect(tail.journal.length).toBeLessThan(20);
    expect(tail.journalCount).toBe(20);
    expect(tail.journalWindow).toMatchObject({ mode: "tail", total: 20, returned: tail.journal.length, truncated: true, maxBytes: 4096 });
    expect(tail.journalWindow.note).toContain('journal="all"');
    // The tail is the END of the log — execution context, where the newest entry is the one that matters.
    expect(tail.journal.at(-1).text).toContain("entry 19");
    expect(JSON.stringify(tail).length).toBeLessThan(JSON.stringify(await read({ journal: "all" })).length);

    // The declared escape hatch actually delivers the whole journal.
    const all = await read({ journal: "all" });
    expect(all.journal).toHaveLength(20);
    expect(all.journalWindow).toMatchObject({ mode: "all", returned: 20, total: 20, truncated: false });
    expect(all.journalWindow.note).toBeUndefined();

    // State only, and it still says the 20 entries exist.
    const none = await read({ journal: "none" });
    expect(none.journal).toEqual([]);
    expect(none.journalCount).toBe(20);
    expect(none.journalWindow).toMatchObject({ mode: "none", total: 20, truncated: true });

    // journalOffset walks the whole log forward, one bounded page at a time.
    const walked: string[] = [];
    for (let offset = 0, guard = 0; offset < 20 && guard < 40; guard++) {
      const page = await read({ journalOffset: offset });
      expect(page.journal.length).toBeGreaterThan(0);
      walked.push(...page.journal.map((e: { text: string }) => e.text));
      offset = page.journalWindow.offset + page.journalWindow.returned;
    }
    expect(walked).toEqual(all.journal.map((e: { text: string }) => e.text));

    const past = await read({ journalOffset: 99 });
    expect(past.journal).toEqual([]);
    expect(past.journalWindow.note).toContain("beyond the 20 entries");
  });

  it("create_task rejects oversized authoring input atomically with decomposition guidance", async () => {
    const beforeIds = tasks.listRaw().map((task) => task.id);
    const beforeChanges = taskChanges;
    const beforeNotifications = notifications.length;
    const errorText = async (arguments_: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name: "create_task", arguments: { ...arguments_, agent: "claude" } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n");
      expect(text.length).toBeLessThan(1_500);
      return text;
    };

    const secretBody = `SECRET-${"x".repeat(3_994)}`;
    const bodyError = await errorText({ title: "Four-slice delivery", body: secretBody });
    expect(bodyError).toContain("create_task body received 4001 code points; maximum 4000");
    expect(bodyError).toContain("Do not truncate");
    expect(bodyError).toContain("four independently shippable slices");
    expect(bodyError).toContain("one umbrella Task plus explicit follow-up Tasks");
    expect(bodyError).toContain("append_task_note");
    expect(bodyError).toContain("artifact_refs");
    expect(bodyError).toContain("does not create follow-ups or infer dependencies automatically");
    expect(bodyError).not.toContain("SECRET");

    expect(await errorText({ title: "t".repeat(301) })).toContain("title received 301 code points; maximum 300");
    expect(await errorText({ title: "Bounded", kind: "k".repeat(65) })).toContain("kind received 65 code points; maximum 64");
    expect(await errorText({
      title: "Bounded",
      artifact_refs: Array.from({ length: 11 }, (_, index) => ({ type: "file", ref: `docs/${index}` })),
    })).toContain("artifact_refs received 11 entries; maximum 10");
    expect(await errorText({ title: "Bounded", artifact_refs: [{ type: "t".repeat(65), ref: "docs/spec.md" }] }))
      .toContain("artifact_refs.type received 65 code points; maximum 64");
    expect(await errorText({ title: "Bounded", artifact_refs: [{ type: "file", ref: "r".repeat(501) }] }))
      .toContain("artifact_refs.ref received 501 code points; maximum 500");

    expect(tasks.listRaw().map((task) => task.id)).toEqual(beforeIds);
    expect(taskChanges).toBe(beforeChanges);
    expect(notifications).toHaveLength(beforeNotifications);
  });

  it("create_task advertises its canonical authoring limits and decomposition policy", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === "create_task");
    expect(tool?.description).toContain("four independently shippable slices");
    expect(tool?.description).toContain("one umbrella Task and explicit follow-up Tasks");
    expect(tool?.description).toContain("append_task_note");
    expect(tool?.description).toContain("durable artifact");
    expect(tool?.description).toContain("does not create follow-ups or infer dependencies automatically");

    const properties = (tool?.inputSchema as {
      properties?: Record<string, { maxLength?: number; maxItems?: number; items?: { properties?: Record<string, { maxLength?: number }> } }>;
    }).properties;
    expect(properties?.title?.maxLength).toBe(300);
    expect(properties?.body?.maxLength).toBe(4_000);
    expect(properties?.kind?.maxLength).toBe(64);
    expect(properties?.artifact_refs?.maxItems).toBe(10);
    expect(properties?.artifact_refs?.items?.properties?.type?.maxLength).toBe(64);
    expect(properties?.artifact_refs?.items?.properties?.ref?.maxLength).toBe(500);
  });

  it("task tools accept artifact ref roles", async () => {
    const created = await client.callTool({
      name: "create_task",
      arguments: {
        title: "Related spec only",
        artifact_refs: [{ type: "sdd", ref: "358-runtime-profile", role: "relation" }],
        agent: "claude",
      },
    });
    expect(created.isError).toBeFalsy();
    // t-f638bd — the receipt carries the id; the accepted refs are read back from the stored task.
    const receipt = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    const stored = JSON.parse(
      ((await client.callTool({ name: "get_task", arguments: { id: receipt.id } })).content as Array<{ text: string }>)[0].text,
    );
    expect(stored.task.artifact_refs).toEqual([{ type: "sdd", ref: "358-runtime-profile", role: "relation" }]);
  });

  it("validation tools round-trip through MCP with open type, routing, CAS claim, and proof-on-close", async () => {
    const created = await client.callTool({
      name: "create_validation",
      arguments: {
        title: "Dogfood image flow",
        type: "game-review",
        executor: "either",
        priority: 1,
        instructions: "Open the game and verify the asset flow.",
        source_refs: [{ type: "pin", ref: "p-c429fb" }],
        agent: "claude",
      },
    });
    expect(created.isError).toBeFalsy();
    const validation = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    expect(validation).toMatchObject({ title: "Dogfood image flow", author: "claude", status: "pending", type: "game-review" });

    await client.callTool({ name: "update_validation", arguments: { id: validation.id, status: "triaged" } });
    const listed = await client.callTool({ name: "list_validations", arguments: { limit: 10 } });
    const summaries = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
    expect(summaries[0]).toMatchObject({ id: validation.id, priority: 1, type: "game-review", status: "triaged" });
    expect(summaries[0].instructions).toBeUndefined();

    const next = await client.callTool({ name: "next_validation", arguments: { agent: "codex" } });
    const candidate = JSON.parse((next.content as Array<{ text: string }>)[0].text);
    expect(candidate).toMatchObject({ validation: { id: validation.id } });

    const claimed = await client.callTool({ name: "update_validation", arguments: { id: validation.id, assignee: "codex", expect: { assignee: null } } });
    expect(claimed.isError).toBeFalsy();

    const running = await client.callTool({ name: "update_validation", arguments: { id: validation.id, status: "running" } });
    expect(running.isError).toBeFalsy();

    const closeWithoutProof = await client.callTool({ name: "close_validation", arguments: { id: validation.id, outcome: "passed" } });
    expect(closeWithoutProof.isError).toBe(true);
    expect(JSON.stringify(closeWithoutProof.content)).toContain("requires evidence_refs or result_note");

    const closed = await client.callTool({
      name: "close_validation",
      arguments: { id: validation.id, outcome: "failed", result_note: "Image output did not render", evidence_refs: [{ type: "file", ref: "screenshots/fail.png" }] },
    });
    expect(closed.isError).toBeFalsy();
    const closedParsed = JSON.parse((closed.content as Array<{ text: string }>)[0].text);
    expect(closedParsed).toMatchObject({
      id: validation.id,
      status: "closed",
      rounds: [{ n: 1, outcome: "failed", closedBy: { kind: "legacy" } }],
    });

    const full = await client.callTool({ name: "get_validation", arguments: { id: validation.id } });
    expect(JSON.parse((full.content as Array<{ text: string }>)[0].text).rounds[0].result_note).toContain("Image output");
    expect(validationChanges).toBeGreaterThanOrEqual(4);
  });

  it("discover_validation_candidates surfaces existing dogfood debt without creating validations", async () => {
    const specDir = nodePath.join(pinsRoot, "docs", "specs", "900-fixture");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(nodePath.join(specDir, "tasks.md"), "- [ ] Human dogfood the settings flow\n", "utf8");

    const result = await client.callTool({ name: "discover_validation_candidates", arguments: { limit: 10 } });
    expect(result.isError).toBeFalsy();
    const candidates = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(candidates).toContainEqual(expect.objectContaining({
      title: "Validate 900-fixture",
      excerpt: "Human dogfood the settings flow",
      executor: "human",
      source_ref: { type: "sdd", ref: "docs/specs/900-fixture" },
    }));
    expect(validations.list()).toHaveLength(1); // discovery is read-only; the one existing validation came from the prior test
  });

  it("continuity tools round-trip through MCP onto the per-agent file (spec 241)", async () => {
    const status0 = await client.callTool({ name: "continuity_status", arguments: { agent: "claude" } });
    expect(JSON.parse((status0.content as Array<{ text: string }>)[0].text)).toMatchObject({ agent: "claude", exists: false }); // cold start
    const cold = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    expect((cold.content as Array<{ text: string }>)[0].text).toContain("# Derived Open Work");

    const set = await client.callTool({ name: "set_continuity", arguments: { agent: "claude", content: "# Current Goal\nship spec 241", status: "active" } });
    expect(set.isError).toBeFalsy();
    // the file door agrees with the tool door
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "continuity", "claude.md"), "utf8")).toContain("ship spec 241");

    const got = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    expect(JSON.stringify(got.content)).toContain("ship spec 241");

    const status1 = await client.callTool({ name: "continuity_status", arguments: { agent: "claude" } });
    const parsed = JSON.parse((status1.content as Array<{ text: string }>)[0].text);
    expect(parsed).toMatchObject({ agent: "claude", exists: true, status: "active", source_activity_seq: 7, current_activity_seq: 7, lag: 0 });
  });

  it("get_continuity derives open work without storing it and leads with stale lag", async () => {
    const task = await tasks.create({ title: "Reconcile live continuity", author: "human", assignee: "claude" });
    await tasks.update(task.id, { status: "triaged" });
    await tasks.update(task.id, { status: "active" });
    const pin = pins.create("Review continuity contract", "claude");
    pins.create("Another agent's reminder", "codex");
    activitySeq = 108;

    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: "# Current Goal\nship", source_activity_seq: 7 },
    });
    const got = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    const text = (got.content as Array<{ text: string }>)[0].text;

    expect(text).toMatch(/^STALE: continuity brief is 101 activity records behind/);
    expect(text).toContain(`- ${task.id}: Reconcile live continuity`);
    expect(text).toContain(`- ${pin.id}: Review continuity contract`);
    expect(text).not.toContain("Another agent's reminder");
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "continuity", "claude.md"), "utf8")).not.toContain("Derived Open Work");

    activitySeq = 7;
    await tasks.update(task.id, { status: "done" });
    pins.setDone(pin.id, true);
  });

  it("set_continuity does not store or accumulate derived open work from a full read response", async () => {
    const authoredBody = "# Current Goal\nkeep the narrative";
    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: authoredBody },
    });

    const storedBodies: string[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const read = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
      const projection = (read.content as Array<{ text: string }>)[0].text;
      await client.callTool({
        name: "set_continuity",
        arguments: { agent: "claude", content: projection },
      });
      storedBodies.push(continuity.read("claude")?.body ?? "");
    }

    expect(storedBodies).toEqual(Array.from({ length: 5 }, () => authoredBody));
    expect(storedBodies.every((body) => !body.includes("# Derived Open Work"))).toBe(true);
  });

  it("set_continuity does not persist a stale prefix from a full read response", async () => {
    activitySeq = 108;
    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: "# Current Goal\nrefresh", source_activity_seq: 7 },
    });
    const staleRead = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    const staleProjection = (staleRead.content as Array<{ text: string }>)[0].text;
    expect(staleProjection).toMatch(/^STALE:/);

    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: staleProjection },
    });

    expect(continuity.read("claude")?.body).toBe("# Current Goal\nrefresh");
    const freshRead = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    expect((freshRead.content as Array<{ text: string }>)[0].text).not.toMatch(/^STALE:/);
    activitySeq = 7;
  });

  it("set_continuity does not store the cold-start placeholder from a full read response", async () => {
    continuity.remove("claude");
    const coldRead = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    const coldProjection = (coldRead.content as Array<{ text: string }>)[0].text;

    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: coldProjection },
    });

    expect(continuity.read("claude")?.body).toBe("");
  });

  it("set_continuity preserves a derived open work heading inside the authored narrative", async () => {
    const authoredContent = [
      "# Current Goal",
      "keep the narrative",
      "",
      "# Derived Open Work",
      "",
      "This human-authored context stays.",
      "",
      "# Next",
      "continue",
    ].join("\n");
    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: authoredContent },
    });

    const read = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    const projection = (read.content as Array<{ text: string }>)[0].text;
    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: projection },
    });

    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "continuity", "claude.md"), "utf8"))
      .toContain("# Derived Open Work\n\nThis human-authored context stays.\n\n# Next");
  });

  it("set_continuity preserves human-authored YAML frontmatter", async () => {
    const authoredBody = "---\ntitle: Human notes\n---\n# Current Goal\ncontinue";
    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: authoredBody },
    });
    const read = await client.callTool({ name: "get_continuity", arguments: { agent: "claude" } });
    const projection = (read.content as Array<{ text: string }>)[0].text;

    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: projection },
    });

    expect(continuity.read("claude")?.body).toBe(authoredBody);
  });

  it("set_continuity warns after removed task ids and wiki links", async () => {
    await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: "# Open Threads\n- t-ed20f5\n- [[decision-log]]" },
    });
    const rewritten = await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: "# Open Threads\n- complete" },
    });

    const text = (rewritten.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("continuity updated");
    expect(text).toContain("removed references: t-ed20f5, [[decision-log]]");
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "continuity", "claude.md"), "utf8")).toContain("- complete");
  });

  it("set_continuity describes authored narrative and derived open work", async () => {
    const { tools: listed } = await client.listTools();
    const tool = listed.find((candidate) => candidate.name === "set_continuity");

    expect(tool?.description).toContain("authored continuity narrative");
    expect(tool?.description).toContain("derives your open tasks and pins during reads");
    expect(tool?.description).not.toContain("keep it SHORT");
  });

  it("set_continuity keeps advisory drop detection non-blocking for malformed prior content", async () => {
    const continuityPath = nodePath.join(pinsRoot, ".tachyon", "continuity", "claude.md");
    fs.writeFileSync(continuityPath, "malformed prior content with t-ed20f5", "utf8");

    const rewritten = await client.callTool({
      name: "set_continuity",
      arguments: { agent: "claude", content: "# Current Goal\nrecover" },
    });

    expect(rewritten.isError).toBeFalsy();
    expect((rewritten.content as Array<{ text: string }>)[0].text).toBe("continuity updated");
    expect(fs.readFileSync(continuityPath, "utf8")).toContain("# Current Goal\nrecover");
  });

  it("project-handoff tools round-trip through MCP: append (any agent) + CAS rewrite (owner) (spec 245)", async () => {
    // cold start
    const cold = await client.callTool({ name: "get_project_handoff", arguments: {} });
    expect(JSON.parse((cold.content as Array<{ text: string }>)[0].text)).toMatchObject({ exists: false, pending_notes: 0, staleness: "fresh" });

    // any agent appends a pending note (no markdown rewrite)
    const appended = await client.callTool({ name: "append_project_handoff_note", arguments: { agent: "claude", kind: "completed", summary: "shipped the parser", evidence: ["src/x.ts"] } });
    expect(appended.isError).toBeFalsy();
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "handoff-notes.jsonl"), "utf8")).toContain("shipped the parser");

    const afterNote = JSON.parse(((await client.callTool({ name: "get_project_handoff", arguments: {} })).content as Array<{ text: string }>)[0].text);
    expect(afterNote).toMatchObject({ pending_notes: 1, staleness: "needs_distill" });
    // inc G — get returns the pending note ROWS + the watermark to echo when distilling
    expect(afterNote.pending).toEqual([expect.objectContaining({ agent: "claude", kind: "completed", summary: "shipped the parser", evidence: ["src/x.ts"] })]);
    expect(afterNote.pending_through).toBe(afterNote.pending[0].ts);

    // owner distills via a full rewrite, echoing pending_through → clears the folded note (inc G watermark)
    const set = await client.callTool({ name: "set_project_handoff", arguments: { content: "## Current State\nparser shipped", distilled_through: afterNote.pending_through } });
    expect(set.isError).toBeFalsy();
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "HANDOFF.md"), "utf8")).toContain("parser shipped");

    const afterSet = JSON.parse(((await client.callTool({ name: "get_project_handoff", arguments: {} })).content as Array<{ text: string }>)[0].text);
    expect(afterSet).toMatchObject({ exists: true, pending_notes: 0, staleness: "fresh" }); // distilling cleared pending
    const revision = afterSet.revision as string;
    expect(revision).toBeTruthy();

    // CAS: a stale revision is rejected; the right one is accepted
    const stale = await client.callTool({ name: "set_project_handoff", arguments: { content: "racing", expected_revision: "0000000000000000" } });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("CAS mismatch");
    const ok = await client.callTool({ name: "set_project_handoff", arguments: { content: "## Current State\nv2", expected_revision: revision } });
    expect(ok.isError).toBeFalsy();
    expect(fs.readFileSync(nodePath.join(pinsRoot, ".tachyon", "HANDOFF.md"), "utf8")).toContain("v2");
  });

  it("spawn_agent (declared) creates the tmux session", async () => {
    const result = await client.callTool({ name: "spawn_agent", arguments: { name: "claude" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ agent: "claude", state: "ready" });
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
  });

  it("spawn_agent projects model preflight failures as structured content", async () => {
    const result = await client.callTool({
      name: "spawn_agent",
      arguments: { name: "bad-model", cmd: "codex --model missing-model", parent: "claude", skip_contract_reason: "structured preflight fixture" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "runtime_model_unavailable",
        message: "runtime_model_unavailable: model 'missing-model' is unavailable; available close matches: gpt-5.6-sol",
        model: "missing-model",
        suggestions: ["gpt-5.6-sol"],
      },
    });
    expect(sessions.has(`tachyon-${HASH}-bad-model`)).toBe(false);
  });

  it("spawn_agent gates an ad-hoc AI child on a delegation contract (spec 246)", async () => {
    // AI cmd + no contract → rejected before any spawn (state-safe: no session created).
    const noContract = await client.callTool({ name: "spawn_agent", arguments: { name: "child-ai", cmd: "claude", parent: "claude" } });
    expect(noContract.isError).toBe(true);
    const msg = JSON.stringify(noContract.content);
    expect(msg).toContain("delegation contract");
    expect(msg).toMatch(/task:/);
    expect(msg).toMatch(/context:/);
    expect(msg).toMatch(/constraints:/);
    expect(sessions.has(`tachyon-${HASH}-child-ai`)).toBe(false); // not spawned

    // junk values are rejected too (D5 substance check)
    const junk = await client.callTool({
      name: "spawn_agent",
      arguments: { name: "child-ai", cmd: "claude", parent: "claude", task: "asdf", context: "x", constraints: "<fill>", deliverable: "tbd" },
    });
    expect(junk.isError).toBe(true);

    // SDD 478 M9 — a generic command is refused as an AGENT first, which is the more useful answer
    // because it names the operation that WILL run it.
    const terminalCmd = await client.callTool({
      name: "spawn_agent",
      arguments: { name: "child-terminal", cmd: "echo hi", parent: "claude" },
    });
    expect(terminalCmd.isError).toBe(true);
    expect(JSON.stringify(terminalCmd.content)).toContain("is not a supported LLM runtime");
    expect(JSON.stringify(terminalCmd.content)).toContain("spawn_terminal");
    expect(sessions.has(`tachyon-${HASH}-child-terminal`)).toBe(false);

    // a too-short skip reason is rejected (D6)
    const badSkip = await client.callTool({ name: "spawn_agent", arguments: { name: "child-ai", cmd: "claude", skip_contract_reason: "trivial" } });
    expect(badSkip.isError).toBe(true);
    expect(JSON.stringify(badSkip.content)).toContain("skip_contract_reason");
  });

  it("spawn_agent: a contract-skipped spawn without a task receives waiting guidance, not a task brief", async () => {
    const reason = "waiting for a human-authored task";
    const spawned = await client.callTool({
      name: "spawn_agent",
      arguments: { name: "waiting-child", cmd: "claude", parent: "claude", skip_contract_reason: reason },
    });
    expect(spawned.isError).toBeFalsy();
    const launch = launches.get(`tachyon-${HASH}-waiting-child`)?.join(" ");
    expect(launch).toContain("Task: absent — awaiting assignment.");
    expect(launch).toContain(`Recorded skip reason: ${reason}`);
    expect(launch).toContain("Do not scan unrelated tasks, pins, or continuity");
    await client.callTool({ name: "kill_agent", arguments: { name: "waiting-child" } });
  });

  it("spawn_agent refuses skip_contract_reason with structured contract fields (t-7b9e60 B)", async () => {
    const spawned = await client.callTool({
      name: "spawn_agent",
      arguments: {
        name: "contradictory-child",
        cmd: "claude",
        parent: "claude",
        task: "Inspect the parser fixture and report the finding.",
        context: "A read-only consultation.",
        constraints: "Do not modify files.",
        done_when: "The parent receives the finding.",
        skip_contract_reason: "this should be rejected as contradictory",
      },
    });

    expect(spawned.isError).toBe(true);
    const message = JSON.stringify(spawned.content);
    expect(message).toContain("skip_contract_reason");
    expect(message).toContain("task, context, constraints, done_when");
    expect(message).toContain("remove skip_contract_reason");
    expect(message).toContain("remove the structured contract fields");
    expect(sessions.has(`tachyon-${HASH}-contradictory-child`)).toBe(false);

    const completionOnly = await client.callTool({
      name: "spawn_agent",
      arguments: {
        name: "contradictory-deliverable-child",
        cmd: "claude",
        parent: "claude",
        deliverable: "A concise report.",
        skip_contract_reason: "this should also be rejected",
      },
    });
    expect(completionOnly.isError).toBe(true);
    expect(JSON.stringify(completionOnly.content)).toContain("deliverable");
    expect(sessions.has(`tachyon-${HASH}-contradictory-deliverable-child`)).toBe(false);
  });



  it("SDD 478 M9: spawn_agent refuses a generic command and names spawn_terminal, before the contract gate", async () => {
    // Order is the point. A generic command used to become a Terminal here; now it is refused, and the
    // refusal must be about the ENTITY, not about a missing delegation contract — otherwise the caller
    // is sent to write a brief for something this door was never going to create.
    const refused = await client.callTool({
      name: "spawn_agent",
      arguments: { name: "shelly", cmd: "sh -c 'echo hi'", parent: "claude" },
    });
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("spawn_terminal");
    expect(text).not.toContain("delegation contract");
    expect(sessions.has(`tachyon-${HASH}-shelly`)).toBe(false);
  });

  it("SDD 478 M9: spawn_terminal starts a terminal-kind row and carries no agent parameters", async () => {
    const tools = (await client.listTools()).tools;
    const schema = tools.find((t) => t.name === "spawn_terminal")?.inputSchema as { properties?: Record<string, unknown> };
    // Agent-only capabilities are unrepresentable here, not merely rejected: there is no parameter to
    // put a task, a lineage, a brief, a worktree or a delegation gate into.
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["cmd", "cwd", "name"]);

    const started = await client.callTool({ name: "spawn_terminal", arguments: { name: "devserver", cmd: "npm run dev" } });
    expect(started.isError).toBeFalsy();
    expect(sessions.has(`tachyon-${HASH}-devserver`)).toBe(true);
    expect(manager.kindOf("devserver")).toBe("terminal");
    await client.callTool({ name: "kill_agent", arguments: { name: "devserver" } });
  });

  it("spawn_agent (ad-hoc) + maxAgents guardrail + lineage", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "helper", cmd: "opencode", parent: "claude", skip_contract_reason: "lifecycle fixture: no delegated work" } });
    expect(sessions.has(`tachyon-${HASH}-helper`)).toBe(true);
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    const parsed = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{ name: string; parent?: string }>;
    expect(parsed.find((a) => a.name === "helper")?.parent).toBe("claude");

    const blocked = await client.callTool({ name: "spawn_agent", arguments: { name: "third", cmd: "opencode", skip_contract_reason: "guardrail fixture: never actually spawns" } });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("maxAgents limit reached (2)");
    await client.callTool({ name: "kill_agent", arguments: { name: "helper" } });
  });

  it("dismiss_agent rejects running ad-hoc entries and declared entries", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "running-helper", cmd: "opencode", parent: "claude", skip_contract_reason: "lifecycle fixture: no delegated work" } });
    const running = await client.callTool({ name: "dismiss_agent", arguments: { name: "running-helper" } });
    expect(running.isError).toBe(true);
    expect(JSON.stringify(running.content)).toContain("use kill_agent first");
    expect(sessions.has(`tachyon-${HASH}-running-helper`)).toBe(true);

    const declared = await client.callTool({ name: "dismiss_agent", arguments: { name: "claude" } });
    expect(declared.isError).toBe(true);
    // SDD 482 phase 5 — new vocabulary, old term retained in the same sentence so this assertion (and
    // anyone grepping logs) keeps working across the rename.
    expect(JSON.stringify(declared.content)).toContain("Saved Agent (declared in tachyon.yml)");

    const missing = await client.callTool({ name: "dismiss_agent", arguments: { name: "missing" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("not found");

    const killed = await client.callTool({ name: "kill_agent", arguments: { name: "running-helper" } });
    expect(killed.isError).toBeFalsy();
  });

  it("dismiss_agent removes stopped ad-hoc entries; kill_agent points stopped ad-hoc users to dismiss_agent", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "stopped-helper", cmd: "opencode", parent: "claude", skip_contract_reason: "lifecycle fixture: no delegated work" } });
    const session = sessionName(HASH, "stopped-helper");
    expect(sessions.has(session)).toBe(true);
    sessions.delete(session); // simulate a clean-exited pane that has already disappeared from tmux.

    const killStopped = await client.callTool({ name: "kill_agent", arguments: { name: "stopped-helper" } });
    expect(killStopped.isError).toBe(true);
    expect(JSON.stringify(killStopped.content)).toContain("dismiss_agent");

    const dismissed = await client.callTool({ name: "dismiss_agent", arguments: { name: "stopped-helper" } });
    expect(dismissed.isError).toBeFalsy();
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    const parsed = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{ name: string }>;
    expect(parsed.map((a) => a.name)).not.toContain("stopped-helper");
  });

  it("read_output returns the sibling's pane text", async () => {
    const result = await client.callTool({ name: "read_output", arguments: { name: "claude" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("fake output");
  });

  it("spec 351 T7 (dueto F8): read_output redacts a Bridge-token-shaped pattern from LIVE captured pane text", async () => {
    const session = sessionName(HASH, "claude");
    const before = panes.get(session);
    const token = "c".repeat(64);
    panes.set(session, `some output\nTACHYON_AGENT_BRIDGE_TOKEN=${token}\ncurl -H "Authorization: Bearer ${token}"`);
    try {
      const result = await client.callTool({ name: "read_output", arguments: { name: "claude" } });
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result.content);
      expect(text).not.toContain(token);
      expect(text).toContain("TACHYON_AGENT_BRIDGE_TOKEN=[redacted]");
    } finally {
      if (before === undefined) panes.delete(session);
      else panes.set(session, before);
    }
  });

  it("write_input: submit=true routes through the hardened submit path for an idle/untracked recipient (t-12ec8a)", async () => {
    // "claude" is stubbed needs-input in this fixture (attentionOf), so this uses a fresh untracked
    // sibling — attentionOf returns undefined for it, which is treated as safe-to-submit (spec 348).
    await client.callTool({ name: "spawn_agent", arguments: { name: "write-target", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    const result = await client.callTool({ name: "write_input", arguments: { name: "write-target", text: "hello sibling" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("submitted");
    expect(sessions.get(`tachyon-${HASH}-write-target`)).toBe("hello sibling");
    await client.callTool({ name: "kill_agent", arguments: { name: "write-target" } });
  });

  it("write_input: submit=true against a working/throttled recipient is refused with a structured error, not queued (t-12ec8a)", async () => {
    claudeAttention = "throttled";
    try {
      const before = sessions.get(`tachyon-${HASH}-claude`);
      const result = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "should not land" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/refused-busy/);
      expect(JSON.stringify(result.content)).toMatch(/throttled/);
      expect(JSON.stringify(result.content)).toMatch(/notify_agent/);
      // the pane must be untouched by a refused write — no silent queueing, no partial type.
      expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(before);
    } finally {
      claudeAttention = "needs-input";
    }
  });

  it("write_input: submit=true against a non-empty composer is refused unless answering needs-input (t-f45313)", async () => {
    claudeAttention = "idle";
    claudeComposerOccupied = true;
    try {
      const before = sessions.get(`tachyon-${HASH}-claude`);
      const refused = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "should not land" } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/refused-composer/);
      expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(before);

      claudeAttention = "needs-input";
      const answered = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "1", answering: true } });
      expect(answered.isError).toBeFalsy();
      expect(JSON.stringify(answered.content)).toContain("answered-prompt");
      expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("1");
    } finally {
      claudeAttention = "needs-input";
      claudeComposerOccupied = false;
    }
  });

  it("write_input: a draft the POLL has not seen yet still refuses — the pane wins over the cache (t-a53dd9)", async () => {
    // The incident's shape, on write_input's door: the human started typing after the last attention
    // capture, so the cached reading still says the composer is free. Before this task that cached
    // "false" was the whole guard, and the write landed on top of what the human was typing.
    claudeAttention = "idle";
    claudeComposerOccupied = false;
    claudeComposerDraftNow = true;
    try {
      const before = sessions.get(`tachyon-${HASH}-claude`);
      const refused = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "should not land" } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/refused-composer/);
      expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(before);
    } finally {
      claudeAttention = "needs-input";
      claudeComposerDraftNow = undefined;
    }
  });

  it("write_input: a runtime that cannot answer falls back to the poll, never to 'clear' (t-a53dd9)", async () => {
    // The other direction of the same three-valued contract. `undefined` means "this runtime declares
    // no composer region", and flattening it to false would hand every unprofiled runtime a guard
    // that always says the pane is free — a fix that silently un-fixes itself.
    claudeAttention = "idle";
    claudeComposerDraftNow = undefined;
    claudeComposerOccupied = true;
    try {
      const before = sessions.get(`tachyon-${HASH}-claude`);
      const refused = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "should not land" } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/refused-composer/);
      expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(before);
    } finally {
      claudeAttention = "needs-input";
      claudeComposerOccupied = false;
    }
  });

  it("write_input: submit=true against needs-input is ALLOWED — answering a prompt is the legitimate case (t-8605be)", async () => {
    // "claude" is stubbed needs-input by default in this fixture — 348 over-restricted this to a
    // refusal; t-8605be corrects it, since answering a child's prompt is write_input's most legitimate use.
    const result = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "1" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("submitted");
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("1");
  });

  it("write_input: answering=true against needs-input documents intent with an answered-prompt receipt (t-8605be)", async () => {
    const result = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "2", answering: true } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("answered-prompt");
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("2");
  });

  it("write_input: answering=true against a non-needs-input recipient is a no-op for the receipt (still submitted)", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "answer-target", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    const result = await client.callTool({ name: "write_input", arguments: { name: "answer-target", text: "hi", answering: true } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("(receipt: submitted)");
    expect(JSON.stringify(result.content)).not.toContain("answered-prompt");
    await client.callTool({ name: "kill_agent", arguments: { name: "answer-target" } });
  });

  it("write_input: submit=false stays raw even against a busy recipient (t-12ec8a)", async () => {
    const result = await client.callTool({ name: "write_input", arguments: { name: "claude", text: "typed only", submit: false } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("typed-unsubmitted");
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("typed only");
  });

  it("t-f87651: write_input refuses while a Codex agent is still bootstrapping (not ready)", async () => {
    // Fresh Codex spawn: launch readiness window is 0 under VITEST → pending, not readyAgents.
    // Fake capture lacks "Ask anything" / "Type a message" → isReady stays false.
    await client.callTool({
      name: "spawn_agent",
      arguments: { name: "boot-codex", cmd: "codex", parent: "claude", skip_contract_reason: "test fixture first-contract bootstrap" },
    });
    const session = `tachyon-${HASH}-boot-codex`;
    const before = sessions.get(session);
    const refused = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex", text: "FIRST CONTRACT: implement the thing" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/refused-not-ready/);
    expect(JSON.stringify(refused.content)).toMatch(/bootstrapping|not ready/i);
    expect(sessions.get(session)).toBe(before);

    // Promote readiness via the same classifier observeLaunchReadiness uses, then deliver succeeds.
    panes.set(session, "Ask anything\n");
    const ok = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex", text: "FIRST CONTRACT: implement the thing" },
    });
    expect(ok.isError).toBeFalsy();
    expect(JSON.stringify(ok.content)).toContain("submitted");
    expect(sessions.get(session)).toBe("FIRST CONTRACT: implement the thing");
    await client.callTool({ name: "kill_agent", arguments: { name: "boot-codex" } });
  });

  it("SDD 370: write_input admits only explicit measured bootstrap answers and keeps assignment gated", async () => {
    await client.callTool({
      name: "spawn_agent",
      arguments: { name: "boot-codex-input", cmd: "codex", parent: "claude", skip_contract_reason: "test fixture bounded bootstrap input" },
    });
    const session = `tachyon-${HASH}-boot-codex-input`;
    panes.set(session, 'WARNING: TERM is set to "dumb". Continue anyway? [y/N]:');

    const noIntent = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex-input", text: "y" },
    });
    expect(noIntent.isError).toBe(true);
    expect(JSON.stringify(noIntent.content)).toContain("refused-not-ready");

    const contract = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex-input", text: "FIRST CONTRACT: implement the thing", answering: true },
    });
    expect(contract.isError).toBe(true);
    expect(JSON.stringify(contract.content)).toContain("refused-not-ready");

    const terminal = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex-input", text: "y", answering: true },
    });
    expect(terminal.isError).toBeFalsy();
    expect(JSON.stringify(terminal.content)).toContain("answered-bootstrap; prompt: terminal-warning");

    panes.set(session, [
      "Hooks",
      "Lifecycle hooks from config and enabled plugins.",
      "⚠ 1 hook needs review before it can run.",
      "Press t to trust all; enter to review hooks; esc to close",
    ].join("\n"));
    const unsafeRaw = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex-input", text: "FIRST CONTRACT", submit: false, answering: true },
    });
    expect(unsafeRaw.isError).toBe(true);
    expect(JSON.stringify(unsafeRaw.content)).toContain("refused-not-ready");

    const escape = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex-input", text: "\u001b", submit: false, answering: true },
    });
    expect(escape.isError).toBeFalsy();
    expect(JSON.stringify(escape.content)).toContain("answered-bootstrap; prompt: hooks-overview");
    expect(sessions.get(session)).toBe("\u001b");

    const created = await client.callTool({ name: "create_task", arguments: { title: "Bootstrap remains provisional", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    const assignment = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "boot-codex-input" } });
    expect(assignment.isError).toBe(true);
    expect(JSON.stringify(assignment.content)).toMatch(/before its runtime is ready/);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "dropped" } });

    panes.set(session, "› Use /skills to list available skills\n\n  gpt-5.6-terra default · /tmp/fixture/workspace");
    const afterReady = await client.callTool({
      name: "write_input",
      arguments: { name: "boot-codex-input", text: "FIRST CONTRACT: implement the thing" },
    });
    expect(afterReady.isError).toBeFalsy();
    expect(JSON.stringify(afterReady.content)).toContain("receipt: submitted");
    await client.callTool({ name: "kill_agent", arguments: { name: "boot-codex-input" } });
  });

  it("t-f87651: notify_agent refuses while a Codex agent is still bootstrapping (not ready)", async () => {
    await client.callTool({
      name: "spawn_agent",
      arguments: { name: "boot-codex-n", cmd: "codex", parent: "claude", skip_contract_reason: "test fixture first-contract bootstrap" },
    });
    const session = `tachyon-${HASH}-boot-codex-n`;
    const before = sessions.get(session);
    const doorbellBefore = readDoorbellEvents(pinsRoot).length;
    const refused = await client.callTool({
      name: "notify_agent",
      arguments: { to: "boot-codex-n", summary: "task journal: see j-abc for full contract", agent: "claude" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/refused-not-ready/);
    expect(sessions.get(session)).toBe(before);
    // Bootstrap refuse must not inflate doorbell counts (parent→not-ready child is not a witnessed handoff).
    expect(readDoorbellEvents(pinsRoot)).toHaveLength(doorbellBefore);
    await client.callTool({ name: "kill_agent", arguments: { name: "boot-codex-n" } });
  });

  it("update_task: assigning to a live running agent notifies the assignee (t-ea86e6, case 1/4)", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Ship the thing", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });

    const assigned = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude" } });
    expect(assigned.isError).toBeFalsy();
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(
      `[tachyon] task ${task.id} assigned to you: Ship the thing. Open it with get_task("${task.id}") and begin it.`,
    );
  });

  it("update_task: queues a post-start assignment until the live assignee is idle", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Start after idle", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    const before = sessions.get(`tachyon-${HASH}-claude`);
    noticeMode = "queued";
    try {
      const assigned = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude" } });
      expect(assigned.isError).toBeFalsy();
      expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(before);
    } finally {
      noticeMode = "immediate";
    }
  });

  it("update_task: assigning to a non-agent/unknown/not-running name updates the task with no notice and no error (case 2/4)", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Investigate", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    const beforeClaudeSession = sessions.get(`tachyon-${HASH}-claude`);

    const assigned = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "nobody-here" } });
    expect(assigned.isError).toBeFalsy();
    // t-f638bd — update_task answers with a receipt, not the task. The receipt names what changed and
    // carries the CAS token; the field's committed value is read back from the store's own view.
    const receipt = JSON.parse((assigned.content as Array<{ text: string }>)[0].text);
    expect(receipt).toMatchObject({ id: task.id, status: "triaged", changed: ["assignee"] });
    expect(typeof receipt.updatedAt).toBe("string");
    expect(receipt.title).toBeUndefined();
    const readBack = await client.callTool({ name: "get_task", arguments: { id: task.id } });
    expect(JSON.parse((readBack.content as Array<{ text: string }>)[0].text).task.assignee).toBe("nobody-here");
    expect(sessions.has(`tachyon-${HASH}-nobody-here`)).toBe(false);
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(beforeClaudeSession);
  });

  it("update_task: unassigning (assignee: null) fires no notice (case 3/4)", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Temp", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude" } });
    sessions.set(`tachyon-${HASH}-claude`, "__SENTINEL__");

    const unassigned = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: null } });
    expect(unassigned.isError).toBeFalsy();
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("__SENTINEL__");
  });

  it("update_task: re-asserting the same assignee does not re-notify (case 4/4)", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Same again", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude" } });
    sessions.set(`tachyon-${HASH}-claude`, "__SENTINEL__");

    const reasserted = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude", priority: 2 } });
    expect(reasserted.isError).toBeFalsy();
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("__SENTINEL__");
  });

  // t-f638bd — reconciling is the other operation: recording an outcome that already happened. It must
  // reach done from triaged WITHOUT anyone claiming the task, must keep the evidence, and must still
  // refuse to skip triage — a compact receipt is not licence to make the refusal quiet.
  it("reconcile_task: closes a triaged task with evidence and no assignee, and refuses an untriaged one by name", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Landed elsewhere", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);

    // inbox is refused, and the refusal says why rather than failing silently.
    const untriaged = await client.callTool({ name: "reconcile_task", arguments: { id: task.id, status: "done", evidence: "abc1234" } });
    expect(untriaged.isError).toBe(true);
    expect((untriaged.content as Array<{ text: string }>)[0].text).toMatch(/untriaged|triage it first/);

    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    // The whole point: no assignee anywhere, and update_task would refuse this move.
    const viaUpdate = await client.callTool({ name: "update_task", arguments: { id: task.id, status: "done" } });
    expect(viaUpdate.isError).toBe(true);

    const reconciled = await client.callTool({
      name: "reconcile_task",
      arguments: { id: task.id, status: "done", evidence: "landed as abc1234" },
    });
    expect(reconciled.isError).toBeFalsy();
    const receipt = JSON.parse((reconciled.content as Array<{ text: string }>)[0].text);
    expect(receipt).toMatchObject({ id: task.id, status: "done", changed: ["status"] });
    expect(receipt.title).toBeUndefined();

    const full = JSON.parse(
      ((await client.callTool({ name: "get_task", arguments: { id: task.id } })).content as Array<{ text: string }>)[0].text,
    );
    expect(full.task).toMatchObject({ id: task.id, status: "done" });
    expect(full.task.assignee).toBeUndefined();
    expect(full.journal.at(-1).text).toContain("landed as abc1234");

    // Reconciling a task already there is refused, not silently re-applied.
    const again = await client.callTool({ name: "reconcile_task", arguments: { id: task.id, status: "done", evidence: "abc1234" } });
    expect(again.isError).toBe(true);
    expect((again.content as Array<{ text: string }>)[0].text).toMatch(/already 'done'/);
  });

  it("notify_agent: self-notify, non-agent target, and not-running all fail closed; a real agent target is woken with a sanitized, provenance-enveloped one-liner", async () => {
    // self-notify is rejected regardless of anything else
    const self = await client.callTool({ name: "notify_agent", arguments: { to: "claude", summary: "done", agent: "claude" } });
    expect(self.isError).toBe(true);
    expect(JSON.stringify(self.content)).toMatch(/self-notify/);

    // an unknown/not-running target fails closed (same resolution path as write_input) — t-5f80c6:
    // this now DOES ring the doorbell first (the append moved before the hangable tmux.hasSession
    // preflight), since 'ghost' passes the static self/kindOf checks; a doorbell entry for an attempt
    // that later fails preflight is harmless/correct per protocol_doorbell_missed (existence-only check).
    const notRunning = await client.callTool({ name: "notify_agent", arguments: { to: "ghost", summary: "done", agent: "claude" } });
    expect(notRunning.isError).toBe(true);
    expect(JSON.stringify(notRunning.content)).toContain("not running");

    // a running TERMINAL-kind ad-hoc entry is rejected as a target — this fails the static kindOf check
    // BEFORE the doorbell append, so it rings no doorbell. SDD 478 M9: the terminal now comes from the
    // explicit Terminal operation rather than from spawn_agent guessing `echo` was not an AI CLI, which
    // makes this the stronger test — the row is a terminal because someone SAID so.
    await client.callTool({ name: "spawn_terminal", arguments: { name: "notify-target", cmd: "echo hi" } });
    const toTerminal = await client.callTool({ name: "notify_agent", arguments: { to: "notify-target", summary: "done", agent: "claude" } });
    expect(toTerminal.isError).toBe(true);
    expect(JSON.stringify(toTerminal.content)).toMatch(/not an agent/);
    await client.callTool({ name: "kill_agent", arguments: { name: "notify-target" } });

    // self-notify and the non-agent target above rang no doorbell (they fail static validation before
    // the append); only the 'ghost' attempt above did — spec 363 T1 / t-5f80c6.
    expect(readDoorbellEvents(pinsRoot)).toHaveLength(1);
    expect(readDoorbellEvents(pinsRoot)[0]).toMatchObject({ from: "claude", to: "ghost" });

    // a real AI-CLI ad-hoc sibling is a valid target — envelope is delivered, hostile chars sanitized
    await client.callTool({ name: "spawn_agent", arguments: { name: "sibling", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    const ok = await client.callTool({ name: "notify_agent", arguments: { to: "sibling", summary: "child\rdone\nthe migration", agent: "claude" } });
    expect(ok.isError).toBeFalsy();
    expect(sessions.get(`tachyon-${HASH}-sibling`)).toBe("[tachyon] claude → sibling: child done the migration");

    // the witnessed doorbell now has the earlier failed 'ghost' attempt plus this successful call
    const events = readDoorbellEvents(pinsRoot);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ from: "claude", to: "sibling" });
    await client.callTool({ name: "kill_agent", arguments: { name: "sibling" } });
  });

  it("notify_agent reports queued when semantic delivery defers to idle", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "queued-sibling", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    noticeMode = "queued";
    try {
      const result = await client.callTool({ name: "notify_agent", arguments: { to: "queued-sibling", summary: "done", agent: "claude" } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain("queued 'queued-sibling' for idle delivery");
      // t-fb1453 — the doorbell is tagged as authored BY the sender, which is what stops the flush
      // from discarding it once that sender is dismissed.
      expect(deliveredNoticeMetadata).toEqual({ origin: "agent-authored", sourceChild: "claude", sourceIncarnation: 7 });
      expect(sessions.get(`tachyon-${HASH}-queued-sibling`)).toBe("");
    } finally {
      noticeMode = "immediate";
      await client.callTool({ name: "kill_agent", arguments: { name: "queued-sibling" } });
    }
  });

  // t-167b5c / spec 493 — the read door. Ten of ten notify_agent doorbells in the incident that
  // motivated this arrived AFTER the coordinator had already merged and dismissed the sender; the
  // single working→idle drain window never opened in time. read_notices answers "what rang for me?"
  // straight from the durable witness log, independent of the in-memory NoticeQueue/pane flush.
  it("read_notices: a busy recipient reads a notice it never saw flushed to the pane", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "read-notices-sibling", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    noticeMode = "queued";
    try {
      const notified = await client.callTool({
        name: "notify_agent",
        arguments: { to: "read-notices-sibling", summary: "t-abc done", pointer: "t-abc", agent: "claude" },
      });
      expect(notified.isError).toBeFalsy();
      // the pane never received anything — delivery was queued, not flushed
      expect(sessions.get(`tachyon-${HASH}-read-notices-sibling`)).toBe("");

      const read = await client.callTool({ name: "read_notices", arguments: { agent: "read-notices-sibling" } });
      expect(read.isError).toBeFalsy();
      const body = JSON.parse((read.content as Array<{ text: string }>)[0].text);
      expect(body.notices).toHaveLength(1);
      // no `to` in the response: read_notices is self-only by construction (no parameter can target
      // another agent), so echoing the recipient back would be redundant.
      expect(body.notices[0]).toMatchObject({ from: "claude", pointer: "t-abc" });
      expect(body.notices[0].summary).toContain("t-abc done");
      expect(typeof body.notices[0].at).toBe("string");
    } finally {
      noticeMode = "immediate";
      await client.callTool({ name: "kill_agent", arguments: { name: "read-notices-sibling" } });
    }
  });

  it("read_notices: since-cursor excludes what was already returned, and self-only has no `to` parameter", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "cursor-sibling", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    noticeMode = "queued";
    try {
      await client.callTool({ name: "notify_agent", arguments: { to: "cursor-sibling", summary: "first", agent: "claude" } });
      const firstRead = JSON.parse(
        ((await client.callTool({ name: "read_notices", arguments: { agent: "cursor-sibling" } })).content as Array<{ text: string }>)[0].text,
      );
      expect(firstRead.notices.map((n: { summary?: string }) => n.summary)).toEqual(["first"]);
      const cursor = firstRead.notices[0].at;

      await client.callTool({ name: "notify_agent", arguments: { to: "cursor-sibling", summary: "second", agent: "claude" } });
      const secondRead = JSON.parse(
        ((await client.callTool({ name: "read_notices", arguments: { agent: "cursor-sibling", since: cursor } })).content as Array<{ text: string }>)[0].text,
      );
      expect(secondRead.notices.map((n: { summary?: string }) => n.summary)).toEqual(["second"]);

      // no way to read another agent's notices — the tool has no `to`/target parameter at all
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "read_notices")?.inputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["agent", "since"]);
    } finally {
      noticeMode = "immediate";
      await client.callTool({ name: "kill_agent", arguments: { name: "cursor-sibling" } });
    }
  });

  it("list_agents reports running + declared + attention state", async () => {
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const list = JSON.parse(text) as Array<{ name: string; running: boolean; attention?: string }>;
    expect(list.find((a) => a.name === "claude")?.running).toBe(true);
    expect(list.find((a) => a.name === "claude")?.attention).toBe("needs-input");
  });

  it("list_agents preserves structured tmux queue errors across the Bridge", async () => {
    const list = vi.spyOn(manager, "list").mockRejectedValueOnce(
      new TmuxQueueError(
        "tmux list-sessions timed out waiting for capacity",
        ["list-sessions"],
        "TMUX_QUEUE_TIMEOUT",
        "list-sessions",
        321,
      ),
    );
    try {
      const result = await client.callTool({ name: "list_agents", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: {
          message: "tmux list-sessions timed out waiting for capacity",
          code: "TMUX_QUEUE_TIMEOUT",
          op: "list-sessions",
          queueWaitTimeoutMs: 321,
        },
      });
    } finally {
      list.mockRestore();
    }
  });

  it("list_agents exposes advisory postmortem capabilities for stopped ad-hoc rows", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "postmortem-cap", cmd: "opencode", parent: "claude", skip_contract_reason: "lifecycle fixture: no delegated work" } });
    const session = sessionName(HASH, "postmortem-cap");
    panes.set(session, "alpha\nbeta\ngamma");
    dead.set(session, 0);
    await manager.dismissCleanExitPane("postmortem-cap");

    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    const list = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{
      name: string;
      capabilities?: { canDismiss: boolean; canReadOutput: boolean; readOutputState: string };
    }>;
    expect(list.find((a) => a.name === "postmortem-cap")?.capabilities).toMatchObject({
      canDismiss: true,
      canReadOutput: true,
      readOutputState: "postmortem",
    });

    await client.callTool({ name: "dismiss_agent", arguments: { name: "postmortem-cap" } });
  });

  it("read_output returns retained postmortem output for clean-exited rows and distinguishes missing rows", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "postmortem-read", cmd: "opencode", parent: "claude", skip_contract_reason: "lifecycle fixture: no delegated work" } });
    const session = sessionName(HASH, "postmortem-read");
    panes.set(session, "one\ntwo\nthree");
    dead.set(session, 0);
    await manager.list(); // refresh the cached tmux snapshot so the clean exit is visible to dismiss
    await manager.dismissCleanExitPane("postmortem-read");

    const read = await client.callTool({ name: "read_output", arguments: { name: "postmortem-read", lines: 2 } });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse((read.content as Array<{ text: string }>)[0].text)).toMatchObject({
      output: "two\nthree",
      postmortem: true,
      truncated: true,
      source: "retained",
    });

    await client.callTool({ name: "dismiss_agent", arguments: { name: "postmortem-read" } });
    const missing = await client.callTool({ name: "read_output", arguments: { name: "postmortem-read" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("not found");
  });

  it("list_agents surfaces the verify-gate state (validated handoff)", async () => {
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    const list = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Array<{ name: string; verify?: { passed: boolean; atCommit: string; stale: boolean } }>;
    expect(list.find((a) => a.name === "claude")?.verify).toMatchObject({ passed: true, atCommit: "abc123", stale: true });
  });

  it("agent_touched_files reports one row per LIVE agent, and never folds a missing worktree into an empty file list (t-75e9c7)", async () => {
    const result = await client.callTool({ name: "agent_touched_files", arguments: {} });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse((result.content as Array<{ text: string }>)[0].text) as Array<
      { agent: string; worktree: boolean; files: unknown[]; note?: string }
    >;
    const claude = report.find((r) => r.agent === "claude");
    expect(claude).toMatchObject({ worktree: false, files: [] });
    expect(claude?.note).toMatch(/no isolated worktree/);
    // claude-cowntdown is a declared Saved Agent that is not running — not live, not reported.
    expect(report.some((r) => r.agent === "claude-cowntdown")).toBe(false);
  });

  it("agent_touched_files refuses cleanly when the Bridge has no worktree-diff port", async () => {
    const bareManager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      ledger: new SessionLedger(WS),
      getConfig: () => config,
    });
    const bareBridge = new Bridge({ workspaceRoot: pinsRoot, manager: bareManager, tmux, pins, tasks, validations, notify: () => {} });
    await bareBridge.start();
    try {
      const bareClient = new Client({ name: "test", version: "0.0.0" });
      await bareClient.connect(new StreamableHTTPClientTransport(new URL(bareBridge.url!)));
      const result = await bareClient.callTool({ name: "agent_touched_files", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not available on this Bridge");
      await bareClient.close();
    } finally {
      await bareBridge.dispose();
    }
  });

  it("verify_agent runs the gate and returns the result", async () => {
    const result = await client.callTool({ name: "verify_agent", arguments: { name: "claude" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ passed: true, atCommit: "def456" });
    expect(verifyRuns).toContain("claude");
  });

  it("evidence channel: attach_evidence → list_evidence round-trips; verify_agent folds the summary (spec 273)", async () => {
    // attach a judgment + a warn advisory + an artifact ref to the worktree agent
    const att = await client.callTool({
      name: "attach_evidence",
      arguments: { targetAgent: "claude", producer: "reviewer", kind: "judgment", severity: "info", summary: "UI looks right", artifacts: ["shot.png"] },
    });
    expect(att.isError).toBeFalsy();
    await client.callTool({ name: "attach_evidence", arguments: { targetAgent: "claude", producer: "tdd", kind: "advisory", severity: "warn", summary: "prod changed, no test moved" } });

    // list_evidence reads them back, newest-first, flagged fresh (HEAD == produced commit)
    const listed = await client.callTool({ name: "list_evidence", arguments: { name: "claude" } });
    const recs = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{ kind: string; severity: string; summary: string; stale: boolean; artifacts?: string[] }>;
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ kind: "advisory", severity: "warn", stale: false }); // newest-first
    expect(recs.find((r) => r.kind === "judgment")?.artifacts).toEqual(["shot.png"]);

    // a traversal artifact ref is rejected (never a crash)
    const bad = await client.callTool({ name: "attach_evidence", arguments: { targetAgent: "claude", producer: "x", kind: "artifact", severity: "info", summary: "x", artifacts: ["../escape"] } });
    expect(bad.isError).toBeTruthy();

    // the reserved built-in producer name is rejected (no spoofing verify step-results)
    const spoof = await client.callTool({ name: "attach_evidence", arguments: { targetAgent: "claude", producer: "verify", kind: "step-result", severity: "info", summary: "fake" } });
    expect(spoof.isError).toBeTruthy();

    // verify_agent now carries the compact, mechanical evidence summary (additive; passed unchanged)
    const v = await client.callTool({ name: "verify_agent", arguments: { name: "claude" } });
    const handoff = JSON.parse((v.content as Array<{ text: string }>)[0].text) as { passed: boolean; evidence?: { total: number; bySeverity: Record<string, number> } };
    expect(handoff.passed).toBe(true);
    expect(handoff.evidence?.total).toBe(2);
    expect(handoff.evidence?.bySeverity).toMatchObject({ warn: 1, info: 1 });
  });

  it("complete_node accepts a valid nonce and rejects a bad token / unknown run", async () => {
    const good = await client.callTool({ name: "complete_node", arguments: { runId: "run-1", nodeId: "implement", nonce: "secret-123" } });
    expect(good.isError).toBeFalsy();
    const badNonce = await client.callTool({ name: "complete_node", arguments: { runId: "run-1", nodeId: "implement", nonce: "wrong" } });
    expect(badNonce.isError).toBe(true);
    const unknown = await client.callTool({ name: "complete_node", arguments: { runId: "ghost", nodeId: "x", nonce: "secret-123" } });
    expect(unknown.isError).toBe(true);
  });

  it("notify reaches the human callback", async () => {
    await client.callTool({ name: "notify", arguments: { message: "need a decision", level: "warn" } });
    expect(notifications).toContainEqual({ message: "need a decision", level: "warn" });
  });

  it("kill_agent tears down; errors are structured isError results", async () => {
    await client.callTool({ name: "kill_agent", arguments: { name: "helper" } });
    expect(sessions.has(`tachyon-${HASH}-helper`)).toBe(false);
    const result = await client.callTool({ name: "kill_agent", arguments: { name: "helper" } });
    expect(result.isError).toBe(true);
  });

  it("wait_for_agent: immediate met on current state, gone for unknown agents", async () => {
    // claude's attentionOf is stubbed to needs-input in deps
    const met = await client.callTool({ name: "wait_for_agent", arguments: { name: "claude", until: "needs-input", timeoutSec: 1 } });
    expect(JSON.parse((met.content as Array<{ text: string }>)[0].text)).toMatchObject({ met: true, state: "needs-input" });

    const gone = await client.callTool({ name: "wait_for_agent", arguments: { name: "nope", until: "dead", timeoutSec: 1 } });
    expect(JSON.parse((gone.content as Array<{ text: string }>)[0].text)).toMatchObject({ met: true, state: "gone" });
  });

  it("wait_for_agent can include a bounded final tail when the dead pane still exists", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "wait-tail", cmd: "opencode", parent: "claude", skip_contract_reason: "lifecycle fixture: no delegated work" } });
    const session = sessionName(HASH, "wait-tail");
    panes.set(session, "red\ngreen\nblue");
    dead.set(session, 0);

    const result = await client.callTool({ name: "wait_for_agent", arguments: { name: "wait-tail", until: "dead", timeoutSec: 1, tailLines: 2 } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      met: true,
      state: "dead",
      exitCode: 0,
      tail: "green\nblue",
      tailSource: "tmux",
    });

    await client.callTool({ name: "dismiss_agent", arguments: { name: "wait-tail" } });
  });

  it("wait_for_agent still succeeds with tailUnavailableReason when final-tail capture fails", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "wait-tail-missing", cmd: "opencode", parent: "claude", skip_contract_reason: "lifecycle fixture: no delegated work" } });
    const session = sessionName(HASH, "wait-tail-missing");
    panes.set(session, "__THROW__");
    dead.set(session, 0);

    const result = await client.callTool({ name: "wait_for_agent", arguments: { name: "wait-tail-missing", until: "dead", timeoutSec: 1, tailLines: 2 } });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({
      met: true,
      state: "dead",
      exitCode: 0,
      tailUnavailableReason: "no retained postmortem output is available",
    });

    panes.delete(session);
    await client.callTool({ name: "dismiss_agent", arguments: { name: "wait-tail-missing" } });
  });

  it("rejects non-Bridge paths and MCP session methods without a session", async () => {
    const notFound = await fetch(`http://127.0.0.1:${bridge.port}/other`, { method: "POST" });
    expect(notFound.status).toBe(404);
    const wrongMethod = await fetch(bridge.url!, { method: "DELETE" });
    expect(wrongMethod.status).toBe(404);
  });

  it("t-016e8b: a session id from a previous Bridge process gets 404 on POST so the client re-initializes instead of hanging", async () => {
    const staleHeaders = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "00000000-0000-4000-8000-00000000dead",
    };
    const post = await fetch(bridge.url!, {
      method: "POST",
      headers: staleHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({ error: "MCP session not found" });

    const sse = await fetch(bridge.url!, { headers: { accept: "text/event-stream", "mcp-session-id": staleHeaders["mcp-session-id"] } });
    expect(sse.status).toBe(404);

    // A re-initialize still carrying the stale id is EXEMPT — it is how a reconnecting
    // client mints its new session (mirrors the SDK's own session-validation gate).
    const reinit = await fetch(bridge.url!, {
      method: "POST",
      headers: staleHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stale-reconnect", version: "1.0" } },
      }),
    });
    expect(reinit.status).toBe(200);
    const mintedSession = reinit.headers.get("mcp-session-id");
    expect(mintedSession).toBeTruthy();
    expect(mintedSession).not.toBe(staleHeaders["mcp-session-id"]);

    // Live sessions on the same server are untouched.
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  });
});

describe("stable Bridge port", () => {
  it("derivePort is deterministic and in range", () => {
    const a = derivePort("e5d08dd8");
    expect(a).toBe(derivePort("e5d08dd8"));
    expect(a).toBeGreaterThanOrEqual(DERIVED_PORT_BASE);
    expect(a).toBeLessThan(DERIVED_PORT_BASE + DERIVED_PORT_SPAN);
    expect(derivePort("00000000")).toBe(DERIVED_PORT_BASE);
    expect(derivePort("abcdef12")).not.toBe(derivePort("12fedcba"));
  });

  it("binds the preferred port, and falls back when it is taken", async () => {
    const deps = {
      workspaceRoot: "/tmp",
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      tasks: undefined as never,
      validations: undefined as never,
      notify: () => {},
    };
    const first = new Bridge(deps);
    const port = await first.start(); // ephemeral — gives us a known-taken port
    expect(first.usedFallback).toBe(false);

    const second = new Bridge(deps);
    const fallbackPort = await second.start(port); // preferred is busy
    expect(second.usedFallback).toBe(true);
    expect(fallbackPort).not.toBe(port);

    await second.dispose();
    await first.dispose();

    // Port now free again — a fresh Bridge binds it exactly.
    const third = new Bridge(deps);
    expect(await third.start(port)).toBe(port);
    expect(third.usedFallback).toBe(false);
    await third.dispose();
  });

  it("records request completion metrics and invokes the slow-request hook", async () => {
    const deps = {
      workspaceRoot: "/tmp",
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      tasks: undefined as never,
      validations: undefined as never,
      notify: () => {},
    };
    const completed: BridgeRequestCompleteInfo[] = [];
    const bridge = new Bridge(deps, { onRequestComplete: (info) => completed.push(info), slowRequestMs: 0 });
    await bridge.start();
    await fetch(`http://127.0.0.1:${bridge.port}/not-mcp`);
    expect(completed).toHaveLength(1);
    expect(completed[0].slow).toBe(true);
    expect(completed[0].requestKind).toBe("other");
    expect(bridge.getMetrics()).toMatchObject({ requests: 1, slowRequests: 1 });
    await bridge.dispose();
  });

  it("classifies MCP stream and session requests without pretending they are tools", async () => {
    const deps = {
      workspaceRoot: "/tmp",
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      tasks: undefined as never,
      validations: undefined as never,
      notify: () => {},
    };
    const completed: BridgeRequestCompleteInfo[] = [];
    const bridge = new Bridge(deps, { onRequestComplete: (info) => completed.push(info), slowRequestMs: 0 });
    await bridge.start();

    await fetch(`http://127.0.0.1:${bridge.port}/mcp`, { method: "GET" });
    await fetch(`http://127.0.0.1:${bridge.port}/mcp`, { method: "DELETE" });

    expect(completed).toMatchObject([
      { slow: true, requestKind: "mcp-stream", tool: undefined },
      { slow: true, requestKind: "mcp-session", tool: undefined },
    ]);
    expect(bridge.getMetrics()).toMatchObject({ requests: 2, slowRequests: 2 });
    await bridge.dispose();
  });

  it("adds best-effort tool and identity context to request completion info", async () => {
    const deps = {
      workspaceRoot: "/tmp",
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
      tasks: undefined as never,
      validations: undefined as never,
      notify: () => {},
    };
    const completed: BridgeRequestCompleteInfo[] = [];
    const bridge = new Bridge(deps, { onRequestComplete: (info) => completed.push(info), slowRequestMs: 0 });
    await bridge.start();
    await fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wait_for_agent", arguments: { agent: "cxSlowBridge" } },
      }),
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      slow: true,
      requestKind: "mcp-tool",
      tool: "wait_for_agent",
      claimedIdentity: "cxSlowBridge",
      caller: { kind: "legacy" },
    });
    await bridge.dispose();
  });
});
