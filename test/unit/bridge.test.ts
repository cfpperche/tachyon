import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge, derivePort, DERIVED_PORT_BASE, DERIVED_PORT_SPAN } from "../../src/bridge/Bridge.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, sessionName, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { PinAttachmentStore } from "../../src/pins/PinAttachmentStore.js";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { ContinuityStore } from "../../src/continuity/ContinuityStore.js";
import { ProjectHandoffStore } from "../../src/handoff/ProjectHandoffStore.js";
import { validateCompleteNode } from "../../src/pipeline/completeNode.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { EVIDENCE_SCHEMA_VERSION, isSafeArtifactRef, viewEvidence, summarizeEvidence, type WorktreeEvidence } from "../../src/worktree/evidence.js";
import { readDoorbellEvents } from "../../src/bridge/doorbell.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/**
 * True end-to-end: a real MCP client (the official SDK) talking streamable-HTTP to a
 * real Bridge over loopback — only tmux itself is faked at the executor level.
 */

const WS = "/repo";
const HASH = workspaceHash(WS);

function fakeTmuxExec() {
  const sessions = new Map<string, string>(); // name -> last input
  const dead = new Map<string, number>(); // name -> exit code
  const panes = new Map<string, string>(); // name -> visible/captured pane text
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.set(args[args.indexOf("-s") + 1], "");
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
          const raw = panes.get(target()) ?? `$ fake output for ${target()}\n`;
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
  return { sessions, dead, panes, exec };
}

describe("Bridge end-to-end over streamable HTTP", () => {
  const { sessions, dead, panes, exec } = fakeTmuxExec();
  const notifications: Array<{ message: string; level: string }> = [];
  const config = parseConfig("agents:\n  claude:\n    cmd: claude\nsettings:\n  maxAgents: 2\n").config;
  const tmux = new TmuxService(exec);
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => config,
    getMaxAgents: () => 8,
  });
  const pinsRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tachyon-bridge-pins-"));
  const pins = new PinStore(pinsRoot);
  const tasks = new TaskStore(pinsRoot);
  const validations = new ValidationStore(pinsRoot);
  const continuity = new ContinuityStore(pinsRoot);
  const handoff = new ProjectHandoffStore(pinsRoot);
  const verifyRuns: string[] = [];
  let taskChanges = 0;
  let noticeMode: "immediate" | "queued" = "immediate";
  // t-8605be — "claude"'s attention is mutable so tests can flip it between needs-input (the default,
  // relied on by other suites below: list_agents attention + wait_for_agent) and a genuinely-busy state
  // to exercise write_input's refusal path without disturbing those other tests.
  let claudeAttention: "working" | "idle" | "needs-input" | "throttled" = "needs-input";
  // spec 273 — back the evidence channel with a REAL SessionLedger (a worktree-backed "claude"),
  // wiring attach/list exactly as Workspace does (a fixed HEAD stands in for git). Headless dogfood.
  const evRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tachyon-bridge-ev-"));
  const evLedger = new SessionLedger(evRoot);
  evLedger.record("claude", { def: { cmd: "claude", kind: "agent" }, worktree: { path: "/wt/claude", branch: "b", tachyonCreatedBranch: true, baseRef: "base", createdAt: "t0" }, cwd: "/wt/claude", declared: true });
  const EV_HEAD = "abc123";
  let evSeq = 0;
  let validationChanges = 0;
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
    currentActivitySeq: () => 7,
    notify: (message, level) => notifications.push({ message, level }),
    onTasksChanged: () => { taskChanges += 1; },
    onValidationsChanged: () => { validationChanges += 1; },
    attentionOf: (agent) => (agent === "claude" ? claudeAttention : undefined),
    deliverNotice: async (target, line) => {
      if (noticeMode === "queued") return { status: "queued", queued: 1 };
      await tmux.sendSubmittedLine(manager.session(target), line, { delayMs: 0 });
      return { status: "notified" };
    },
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

  it("exposes exactly the 46 tools (14 agent + 1 host action + 2 evidence + 5 pins + 6 tasks + 7 validations + 3 continuity + 3 handoff + 3 commands/runbooks + 2 schedules)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "append_project_handoff_note",
      "append_task_note",
      "attach_evidence",
      "close_validation",
      "complete_node",
      "complete_pin",
      "continuity_status",
      "create_pin",
      "create_task",
      "create_validation",
      "discover_validation_candidates",
      "dismiss_agent",
      "get_continuity",
      "get_pin",
      "get_project_handoff",
      "get_task",
      "get_validation",
      "kill_agent",
      "list_agents",
      "list_commands",
      "list_evidence",
      "list_pins",
      "list_schedules",
      "list_tasks",
      "list_validations",
      "next_task",
      "next_validation",
      "notify",
      "notify_agent",
      "propose_schedule",
      "read_output",
      "reanchor_agent",
      "restart_agent",
      "run_command",
      "run_host_action",
      "run_runbook",
      "set_continuity",
      "set_project_handoff",
      "spawn_agent",
      "update_pin",
      "update_task",
      "update_validation",
      "verify_agent",
      "verify_task",
      "wait_for_agent",
      "write_input",
    ]);
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

  it("verify_task exposes the full-suite flag in its Bridge schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "verify_task");
    expect(JSON.stringify(tool?.inputSchema)).toContain('"full"');
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

  it("task tools round-trip through MCP with bounded list, next_task, and CAS claim", async () => {
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
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    expect(task).toMatchObject({ title: "Build queue entity", author: "claude", status: "inbox" });

    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged", priority: 1, rank: "a" } });
    const listed = await client.callTool({ name: "list_tasks", arguments: { limit: 10 } });
    const summaries = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
    expect(summaries[0]).toMatchObject({ id: task.id, priority: 1, rank: "a" });
    expect(summaries[0].body).toBeUndefined();

    const next = await client.callTool({ name: "next_task", arguments: { agent: "codex" } });
    const candidate = JSON.parse((next.content as Array<{ text: string }>)[0].text);
    expect(candidate).toMatchObject({ task: { id: task.id } });

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
    expect(fullParsed.journal).toEqual([]);
    expect(taskChanges).toBeGreaterThanOrEqual(3);
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
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    expect(task.artifact_refs).toEqual([{ type: "sdd", ref: "358-runtime-profile", role: "relation" }]);
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
    expect(closedParsed).toMatchObject({ id: validation.id, status: "closed", rounds: [{ n: 1, outcome: "failed" }] });

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
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
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

    // gated delegations need a behavior-level verifier (spec 362 T1)
    const missingBehavior = await client.callTool({
      name: "spawn_agent",
      arguments: {
        name: "child-ai",
        cmd: "claude",
        parent: "claude",
        task: "add retry behavior",
        context: "network client flakes under timeout",
        constraints: "no new dependencies",
        done_when: "retry behavior test passes",
        gate: {},
      },
    });
    expect(missingBehavior.isError).toBe(true);
    expect(JSON.stringify(missingBehavior.content)).toContain("gate.behavior_test");

    // gated delegations cannot bypass the delegation contract with skip_contract_reason.
    const gatedSkip = await client.callTool({
      name: "spawn_agent",
      arguments: {
        name: "child-ai",
        cmd: "claude",
        parent: "claude",
        skip_contract_reason: "test fixture but still gated",
        gate: { behavior_test: "retry behavior" },
      },
    });
    expect(gatedSkip.isError).toBe(true);
    expect(JSON.stringify(gatedSkip.content)).toContain("cannot combine gate with skip_contract_reason");

    // gate is only valid for ad-hoc AI-agent delegations; terminal/non-AI commands reject it instead of ignoring it.
    const terminalGate = await client.callTool({
      name: "spawn_agent",
      arguments: {
        name: "child-terminal",
        cmd: "echo hi",
        parent: "claude",
        gate: { behavior_test: "terminal behavior" },
      },
    });
    expect(terminalGate.isError).toBe(true);
    expect(JSON.stringify(terminalGate.content)).toContain("gate is only supported for an ad-hoc AI sub-agent");
    expect(sessions.has(`tachyon-${HASH}-child-terminal`)).toBe(false);

    // a too-short skip reason is rejected (D6)
    const badSkip = await client.callTool({ name: "spawn_agent", arguments: { name: "child-ai", cmd: "claude", skip_contract_reason: "trivial" } });
    expect(badSkip.isError).toBe(true);
    expect(JSON.stringify(badSkip.content)).toContain("skip_contract_reason");
  });

  it("spawn_agent (ad-hoc) + maxAgents guardrail + lineage", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "helper", cmd: "echo hi", parent: "claude" } });
    expect(sessions.has(`tachyon-${HASH}-helper`)).toBe(true);
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    const parsed = JSON.parse((listed.content as Array<{ text: string }>)[0].text) as Array<{ name: string; parent?: string }>;
    expect(parsed.find((a) => a.name === "helper")?.parent).toBe("claude");

    const blocked = await client.callTool({ name: "spawn_agent", arguments: { name: "third", cmd: "echo no" } });
    expect(blocked.isError).toBe(true);
    expect(JSON.stringify(blocked.content)).toContain("maxAgents limit reached (2)");
    await client.callTool({ name: "kill_agent", arguments: { name: "helper" } });
  });

  it("dismiss_agent rejects running ad-hoc entries and declared entries", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "running-helper", cmd: "echo hi", parent: "claude" } });
    const running = await client.callTool({ name: "dismiss_agent", arguments: { name: "running-helper" } });
    expect(running.isError).toBe(true);
    expect(JSON.stringify(running.content)).toContain("use kill_agent first");
    expect(sessions.has(`tachyon-${HASH}-running-helper`)).toBe(true);

    const declared = await client.callTool({ name: "dismiss_agent", arguments: { name: "claude" } });
    expect(declared.isError).toBe(true);
    expect(JSON.stringify(declared.content)).toContain("declared in tachyon.yml");

    const missing = await client.callTool({ name: "dismiss_agent", arguments: { name: "missing" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("not found");

    const killed = await client.callTool({ name: "kill_agent", arguments: { name: "running-helper" } });
    expect(killed.isError).toBeFalsy();
  });

  it("dismiss_agent removes stopped ad-hoc entries; kill_agent points stopped ad-hoc users to dismiss_agent", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "stopped-helper", cmd: "echo hi", parent: "claude" } });
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

  it("update_task: assigning to a live running agent notifies the assignee (t-ea86e6, case 1/4)", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Ship the thing", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });

    const assigned = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "claude" } });
    expect(assigned.isError).toBeFalsy();
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe(`[tachyon] task ${task.id} assigned to you: Ship the thing`);
  });

  it("update_task: assigning to a non-agent/unknown/not-running name updates the task with no notice and no error (case 2/4)", async () => {
    const created = await client.callTool({ name: "create_task", arguments: { title: "Investigate", agent: "claude" } });
    const task = JSON.parse((created.content as Array<{ text: string }>)[0].text);
    await client.callTool({ name: "update_task", arguments: { id: task.id, status: "triaged" } });
    const beforeClaudeSession = sessions.get(`tachyon-${HASH}-claude`);

    const assigned = await client.callTool({ name: "update_task", arguments: { id: task.id, assignee: "nobody-here" } });
    expect(assigned.isError).toBeFalsy();
    const parsed = JSON.parse((assigned.content as Array<{ text: string }>)[0].text);
    expect(parsed.assignee).toBe("nobody-here");
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

  it("notify_agent: self-notify, non-agent target, and not-running all fail closed; a real agent target is woken with a sanitized, provenance-enveloped one-liner", async () => {
    // self-notify is rejected regardless of anything else
    const self = await client.callTool({ name: "notify_agent", arguments: { to: "claude", summary: "done", agent: "claude" } });
    expect(self.isError).toBe(true);
    expect(JSON.stringify(self.content)).toMatch(/self-notify/);

    // an unknown/not-running target fails closed (same resolution path as write_input)
    const notRunning = await client.callTool({ name: "notify_agent", arguments: { to: "ghost", summary: "done", agent: "claude" } });
    expect(notRunning.isError).toBe(true);
    expect(JSON.stringify(notRunning.content)).toContain("not running");

    // a running TERMINAL-kind ad-hoc entry (echo isn't a known AI CLI) is rejected as a target
    await client.callTool({ name: "spawn_agent", arguments: { name: "notify-target", cmd: "echo hi", parent: "claude" } });
    const toTerminal = await client.callTool({ name: "notify_agent", arguments: { to: "notify-target", summary: "done", agent: "claude" } });
    expect(toTerminal.isError).toBe(true);
    expect(JSON.stringify(toTerminal.content)).toMatch(/not an agent/);
    await client.callTool({ name: "kill_agent", arguments: { name: "notify-target" } });

    // none of the failed calls above rang the Bridge-witnessed doorbell (spec 363 T1)
    expect(readDoorbellEvents(pinsRoot)).toEqual([]);

    // a real AI-CLI ad-hoc sibling is a valid target — envelope is delivered, hostile chars sanitized
    await client.callTool({ name: "spawn_agent", arguments: { name: "sibling", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    const ok = await client.callTool({ name: "notify_agent", arguments: { to: "sibling", summary: "child\rdone\nthe migration", agent: "claude" } });
    expect(ok.isError).toBeFalsy();
    expect(sessions.get(`tachyon-${HASH}-sibling`)).toBe("[tachyon] claude → sibling: child done the migration");

    // and the only witnessed doorbell event is the one successful call, from the RESOLVED caller
    const events = readDoorbellEvents(pinsRoot);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: "claude", to: "sibling" });
    await client.callTool({ name: "kill_agent", arguments: { name: "sibling" } });
  });

  it("notify_agent reports queued when semantic delivery defers to idle", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "queued-sibling", cmd: "claude", parent: "claude", skip_contract_reason: "test fixture, no real delegation" } });
    noticeMode = "queued";
    try {
      const result = await client.callTool({ name: "notify_agent", arguments: { to: "queued-sibling", summary: "done", agent: "claude" } });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain("queued 'queued-sibling' for idle delivery");
      expect(sessions.get(`tachyon-${HASH}-queued-sibling`)).toBe("");
    } finally {
      noticeMode = "immediate";
      await client.callTool({ name: "kill_agent", arguments: { name: "queued-sibling" } });
    }
  });

  it("list_agents reports running + declared + attention state", async () => {
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const list = JSON.parse(text) as Array<{ name: string; running: boolean; attention?: string }>;
    expect(list.find((a) => a.name === "claude")?.running).toBe(true);
    expect(list.find((a) => a.name === "claude")?.attention).toBe("needs-input");
  });

  it("list_agents exposes advisory postmortem capabilities for stopped ad-hoc rows", async () => {
    await client.callTool({ name: "spawn_agent", arguments: { name: "postmortem-cap", cmd: "echo hi", parent: "claude" } });
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
    await client.callTool({ name: "spawn_agent", arguments: { name: "postmortem-read", cmd: "echo hi", parent: "claude" } });
    const session = sessionName(HASH, "postmortem-read");
    panes.set(session, "one\ntwo\nthree");
    dead.set(session, 0);
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
    await client.callTool({ name: "spawn_agent", arguments: { name: "wait-tail", cmd: "echo hi", parent: "claude" } });
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
    await client.callTool({ name: "spawn_agent", arguments: { name: "wait-tail-missing", cmd: "echo hi", parent: "claude" } });
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
});
