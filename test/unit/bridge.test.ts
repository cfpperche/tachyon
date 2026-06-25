import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge, derivePort, DERIVED_PORT_BASE, DERIVED_PORT_SPAN } from "../../src/bridge/Bridge.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { PinAttachmentStore } from "../../src/pins/PinAttachmentStore.js";
import { ContinuityStore } from "../../src/continuity/ContinuityStore.js";
import { ProjectHandoffStore } from "../../src/handoff/ProjectHandoffStore.js";
import { validateCompleteNode } from "../../src/pipeline/completeNode.js";
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
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions.keys()].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions.keys()].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      case "capture-pane":
        return { stdout: `$ fake output for ${target()}\n`, stderr: "" };
      case "send-keys": {
        if (args.includes("-l")) sessions.set(target(), args[args.length - 1]);
        return { stdout: "", stderr: "" };
      }
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, exec };
}

describe("Bridge end-to-end over streamable HTTP", () => {
  const { sessions, exec } = fakeTmuxExec();
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
  const continuity = new ContinuityStore(pinsRoot);
  const handoff = new ProjectHandoffStore(pinsRoot);
  const verifyRuns: string[] = [];
  const bridge = new Bridge({
    manager,
    tmux,
    pins,
    continuity,
    handoff,
    lastActivityAt: () => null,
    currentActivitySeq: () => 7,
    notify: (message, level) => notifications.push({ message, level }),
    attentionOf: (agent) => (agent === "claude" ? "needs-input" : undefined),
    // spec 214 — claude is a worktree agent with a verified-but-now-stale gate; others have none.
    verifyInfo: async (agent) =>
      agent === "claude" ? { command: "npm test", passed: true, atCommit: "abc123", ranAt: "2026-06-14T00:00:00Z", stale: true } : undefined,
    runVerify: async (agent) => {
      verifyRuns.push(agent);
      return { command: "npm test", passed: true, atCommit: "def456", ranAt: "2026-06-14T01:00:00Z", stale: false };
    },
    // spec 230 — a tiny in-test run registry: run-1/implement is running with a known nonce.
    completeNode: async (input) =>
      validateCompleteNode(input, (rid, nid) =>
        rid === "run-1" && nid === "implement" ? { nonce: "secret-123", status: "running", alreadySignalled: false } : null,
      ),
  });
  let client: Client;

  beforeAll(async () => {
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    client = new Client({ name: "test-agent", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url!)));
  });

  afterAll(async () => {
    await client.close();
    await bridge.dispose();
    fs.rmSync(pinsRoot, { recursive: true, force: true });
  });

  it("exposes exactly the 27 tools (11 agent + 5 pins + 3 continuity + 3 handoff + 3 commands/runbooks + 2 schedules)", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "append_project_handoff_note",
      "complete_node",
      "complete_pin",
      "continuity_status",
      "create_pin",
      "get_continuity",
      "get_pin",
      "get_project_handoff",
      "kill_agent",
      "list_agents",
      "list_commands",
      "list_pins",
      "list_schedules",
      "notify",
      "propose_schedule",
      "read_output",
      "reanchor_agent",
      "restart_agent",
      "run_command",
      "run_runbook",
      "set_continuity",
      "set_project_handoff",
      "spawn_agent",
      "update_pin",
      "verify_agent",
      "wait_for_agent",
      "write_input",
    ]);
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
  });

  it("read_output returns the sibling's pane text", async () => {
    const result = await client.callTool({ name: "read_output", arguments: { name: "claude" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("fake output");
  });

  it("write_input lands in the sibling's session", async () => {
    await client.callTool({ name: "write_input", arguments: { name: "claude", text: "hello sibling" } });
    expect(sessions.get(`tachyon-${HASH}-claude`)).toBe("hello sibling");
  });

  it("list_agents reports running + declared + attention state", async () => {
    const result = await client.callTool({ name: "list_agents", arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const list = JSON.parse(text) as Array<{ name: string; running: boolean; attention?: string }>;
    expect(list.find((a) => a.name === "claude")?.running).toBe(true);
    expect(list.find((a) => a.name === "claude")?.attention).toBe("needs-input");
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

  it("rejects non-Bridge paths and non-POST methods", async () => {
    const notFound = await fetch(`http://127.0.0.1:${bridge.port}/other`, { method: "POST" });
    expect(notFound.status).toBe(404);
    const wrongMethod = await fetch(bridge.url!, { method: "DELETE" });
    expect(wrongMethod.status).toBe(405);
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
      manager: undefined as never,
      tmux: undefined as never,
      pins: undefined as never,
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
