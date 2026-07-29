import { describe, expect, it, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools, type BridgeDeps } from "../../src/bridge/tools.js";
import { listSavedAgentProposals, readSavedAgentProposalWitness } from "../../src/agents/savedAgentProposalStore.js";
import { readAgentProfileGrants, workspaceConfigSha256 } from "../../src/config/agentProfileGrants.js";
import { commitAgentProfileLifecycle, inspectAgentProfileLifecycle } from "../../src/config/agentProfileLifecycle.js";
import { proposeSavedAgentGrantPatchFromStudioMutation } from "../../src/config/agentProfileStudio.js";

/**
 * SDD 482 phase 4 slice B (`t-5e1113`) — the only agent-facing door, and what it refuses.
 *
 * The property that matters most here is IDENTITY. The Bridge authenticates with one shared token, so
 * it cannot tell callers apart by anything they say — only by the caller it resolved itself. If this
 * tool accepted a `proposer` argument, any agent could borrow the identity of one holding the grant
 * and the whole capability check would be decorative. So the tests below attack the identity path
 * first and the capability path second.
 */
type ToolHandler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-proposal-bridge-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "tachyon.yml"), "agents:\n  boss:\n    cmd: claude\n", "utf8");
  return dir;
}

/**
 * t-3bde32 — in-memory authority + a real config file, the two ports the canonical transaction needs.
 * Kept local to this file because the point is to drive the SAME transaction Studio drives, not a
 * stand-in for it.
 */
function authorityPort(root: string) {
  const file = path.join(root, ".tachyon", "authority.json");
  const load = (): Record<string, unknown> => {
    try { return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return {}; }
  };
  const save = (records: Record<string, unknown>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records), "utf8");
  };
  return {
    read: async (name: string) => load()[name] as never,
    publish: async (record: { agentName: string }) => {
      const records = load();
      if (records[record.agentName]) throw new Error("authority CAS conflict");
      records[record.agentName] = record; save(records);
    },
    replace: async (record: { agentName: string }, expected: unknown) => {
      const records = load();
      if (JSON.stringify(records[record.agentName]) !== JSON.stringify(expected)) throw new Error("authority CAS conflict");
      records[record.agentName] = record; save(records);
    },
    retire: async (name: string, expected: unknown) => {
      const records = load();
      if (JSON.stringify(records[name]) !== JSON.stringify(expected)) throw new Error("authority CAS conflict");
      delete records[name]; save(records);
    },
  } as never;
}

function configPort(root: string) {
  const file = path.join(root, "tachyon.yml");
  return {
    read: () => fs.readFileSync(file, "utf8"),
    replace: (expected: string, text: string) => {
      const current = fs.readFileSync(file, "utf8");
      const sha = crypto.createHash("sha256").update(current).digest("hex");
      if (sha !== expected) throw new Error("config CAS conflict");
      fs.writeFileSync(file, text, "utf8");
    },
  };
}

/** Writes a canonical profile so the grant read has something real to parse. */
function profile(root: string, agent: string, grants?: Record<string, unknown>): void {
  const dir = path.join(root, ".tachyon", "agents", agent);
  fs.mkdirSync(dir, { recursive: true });
  const doc = [
    "schemaVersion: 1",
    "agentId: 00000000-0000-4000-8000-000000000000",
    "runtime:",
    "  adapter: claude",
    "  executable: claude",
    ...(grants ? ["grants:", ...Object.entries(grants).map(([k, v]) => `  ${k}: ${String(v)}`)] : []),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "agent.yml"), doc, "utf8");
}

function harness(root: string, caller: BridgeDeps["caller"]) {
  const tools = new Map<string, { config: { inputSchema?: Record<string, unknown> }; handler: ToolHandler }>();
  const mcp = {
    registerTool: (name: string, config: { inputSchema?: Record<string, unknown> }, handler: ToolHandler) => {
      tools.set(name, { config, handler });
    },
  };
  // A manager is required now: every proposal creates one ownership edge (proposer owns the new
  // agent), so the roster is always consulted. An empty roster is a real workspace state.
  registerTools(mcp as never, {
    workspaceRoot: root, caller, manager: { list: async () => [] },
  } as unknown as BridgeDeps);
  return {
    schemaOf: (name: string) => JSON.stringify(tools.get(name)?.config.inputSchema ?? {}),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const entry = tools.get(name);
      if (!entry) throw new Error(`tool not registered: ${name}`);
      return entry.handler(args);
    },
  };
}

const PROPOSAL = { name: "importer", runtime_adapter: "claude", rationale: "runs the nightly import" };

describe("propose_saved_agent (SDD 482 phase 4B)", () => {
  it("has no way to name the proposer — identity comes from the Bridge, not the arguments", () => {
    const root = workspace();
    const schema = harness(root, { kind: "agent", name: "claude-runtime" }).schemaOf("propose_saved_agent");
    expect(schema).not.toContain("proposer");
    expect(schema).not.toContain("caller");
  });

  /**
   * The tool cannot even EXPRESS the recursive request. Admission refuses it as well, and that
   * belt-and-braces is deliberate: the schema stops today's callers, the admission check stops
   * whatever calls the store next.
   */
  it("cannot express a request for the proposing capability itself", () => {
    const root = workspace();
    const schema = harness(root, { kind: "agent", name: "claude-runtime" }).schemaOf("propose_saved_agent");
    expect(schema).not.toContain("grants");
    expect(schema).not.toContain("proposeSavedAgent");
  });

  it("refuses a caller the Bridge could not resolve to an agent", async () => {
    const root = workspace();
    const legacy = await harness(root, { kind: "legacy" }).call("propose_saved_agent", PROPOSAL);
    expect(legacy.isError).toBe(true);
    expect(JSON.stringify(legacy.content)).toContain("CALLER_REQUIRED");
    // "No profile" must never read as "no restriction" — that is the classic direction of this bug.
    expect(listSavedAgentProposals(root)).toEqual([]);

    const human = await harness(root, { kind: "human" }).call("propose_saved_agent", PROPOSAL);
    expect(human.isError).toBe(true);
    expect(listSavedAgentProposals(root)).toEqual([]);
  });

  it("refuses an agent whose profile does not hold the grant, naming the capability and the remedy", async () => {
    const root = workspace();
    profile(root, "claude-runtime"); // a real profile, simply without grants
    const refused = await harness(root, { kind: "agent", name: "claude-runtime" }).call("propose_saved_agent", PROPOSAL);
    expect(refused.isError).toBe(true);
    const text = JSON.stringify(refused.content);
    expect(text).toContain("capability_absent");
    expect(text).toContain("grants.proposeSavedAgent");
    expect(text).toContain("Agent Studio");
    expect(listSavedAgentProposals(root)).toEqual([]);
  });

  it("refuses an agent with no profile at all", async () => {
    const root = workspace();
    const refused = await harness(root, { kind: "agent", name: "ghost" }).call("propose_saved_agent", PROPOSAL);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("capability_absent");
  });

  it("records the proposal under the AUTHENTICATED caller when the grant is held", async () => {
    const root = workspace();
    profile(root, "claude-runtime", { proposeSavedAgent: true });
    const accepted = await harness(root, { kind: "agent", name: "claude-runtime" }).call("propose_saved_agent", PROPOSAL);
    expect(accepted.isError).toBeFalsy();

    const stored = listSavedAgentProposals(root);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.proposer).toBe("claude-runtime");
    expect(stored[0]!.spec.name).toBe("importer");
    // The base state is the live config, so a roster change after this point is detectable.
    expect(stored[0]!.base.configSha256).toBe(workspaceConfigSha256(root));

    const receipt = JSON.parse(accepted.content[0]!.text) as Record<string, string>;
    expect(receipt.digest).toBe(stored[0]!.digest);
    // The receipt must not let a proposer believe something was created.
    expect(receipt.state).toContain("nothing is created until a human approves");
  });

  it("collapses a retry rather than queueing a second decision for the human", async () => {
    const root = workspace();
    profile(root, "claude-runtime", { proposeSavedAgent: true });
    const bridge = harness(root, { kind: "agent", name: "claude-runtime" });
    const first = JSON.parse((await bridge.call("propose_saved_agent", PROPOSAL)).content[0]!.text) as { id: string };
    const retry = JSON.parse((await bridge.call("propose_saved_agent", PROPOSAL)).content[0]!.text) as { id: string; collapsedOnto?: string };
    expect(retry.collapsedOnto).toBe(first.id);
    expect(listSavedAgentProposals(root)).toHaveLength(1);
    expect(readSavedAgentProposalWitness(root).map((e) => e.kind)).toEqual(["proposed", "collapsed"]);
  });

  it("still creates nothing: no profile, no roster entry, no authority", async () => {
    const root = workspace();
    profile(root, "claude-runtime", { proposeSavedAgent: true });
    const configBefore = fs.readFileSync(path.join(root, "tachyon.yml"), "utf8");
    await harness(root, { kind: "agent", name: "claude-runtime" }).call("propose_saved_agent", PROPOSAL);

    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toBe(configBefore);
    expect(fs.existsSync(path.join(root, ".tachyon", "agents", "importer"))).toBe(false);
    // …and the proposed agent has no grant to read, because it has no profile to read it from.
    expect(readAgentProfileGrants(root, "importer")).toBeUndefined();
  });
});

describe("t-3bde32 — the grant Studio writes is the grant the Bridge door reads", () => {
  /**
   * The seam this task introduced, end to end and without a human: SDD 482's door was already correct,
   * but nothing could turn the grant ON through a governed path. These two arms prove the profile the
   * canonical transaction writes is the one the door then reads — which is what would silently break
   * if the patch shape were wrong (writing `false` instead of removing the key, or clobbering the
   * wrong object).
   */
  async function commitGrant(root: string, agent: string, granted: boolean): Promise<void> {
    const current = await inspectAgentProfileLifecycle({
      workspaceRoot: root, agentName: agent, authority: authorityPort(root), config: configPort(root),
    });
    await commitAgentProfileLifecycle({
      workspaceRoot: root,
      agentName: agent,
      operation: "edit",
      expectedRevision: current.revision,
      patch: proposeSavedAgentGrantPatchFromStudioMutation(
        { schemaVersion: 1, operation: "set-propose-saved-agent-grant", agentName: agent, expectedRevision: current.revision, granted },
        current,
      ),
      authority: authorityPort(root),
      config: configPort(root),
      activateState: () => undefined,
    });
  }

  it("refuses before the grant, accepts after it, and refuses again after revocation", async () => {
    const root = workspace();
    await commitAgentProfileLifecycle({
      workspaceRoot: root, agentName: "coord", operation: "create",
      createProfile: { runtime: { adapter: "claude", executable: "claude" } },
      authority: authorityPort(root), config: configPort(root), activateState: () => undefined,
    });
    const bridge = harness(root, { kind: "agent", name: "coord" });

    // FAIL-BEFORE: a freshly created agent holds no grant, and the door says so by name.
    const before = await bridge.call("propose_saved_agent", PROPOSAL);
    expect(before.isError).toBe(true);
    expect(JSON.stringify(before.content)).toContain("capability_absent");

    // PASS-AFTER: the grant written by the Studio mutation is read by the door.
    await commitGrant(root, "coord", true);
    const after = await bridge.call("propose_saved_agent", PROPOSAL);
    expect(after.isError).toBeFalsy();
    expect(listSavedAgentProposals(root)).toHaveLength(1);

    // And revocation closes it again — absence, not an explicit `false`.
    await commitGrant(root, "coord", false);
    expect(readAgentProfileGrants(root, "coord")).toEqual({});
    const revoked = await bridge.call("propose_saved_agent", { ...PROPOSAL, name: "other" });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked.content)).toContain("capability_absent");
  });
});

describe("cancel_saved_agent_proposal (SDD 482 phase 4B)", () => {
  async function proposed(root: string) {
    profile(root, "claude-runtime", { proposeSavedAgent: true });
    const bridge = harness(root, { kind: "agent", name: "claude-runtime" });
    const receipt = JSON.parse((await bridge.call("propose_saved_agent", PROPOSAL)).content[0]!.text) as { id: string };
    return receipt.id;
  }

  it("refuses a neighbour trying to withdraw someone else's proposal", async () => {
    const root = workspace();
    const id = await proposed(root);
    const stranger = await harness(root, { kind: "agent", name: "codex-canonico" })
      .call("cancel_saved_agent_proposal", { id, reason: "not mine to cancel" });
    expect(stranger.isError).toBe(true);
    // Suppressing a pending human decision must not be possible unseen.
    expect(listSavedAgentProposals(root)).toHaveLength(1);
  });

  it("lets the proposer withdraw, and converges on a repeat", async () => {
    const root = workspace();
    const id = await proposed(root);
    const bridge = harness(root, { kind: "agent", name: "claude-runtime" });
    expect((await bridge.call("cancel_saved_agent_proposal", { id, reason: "no longer needed" })).isError).toBeFalsy();
    expect(listSavedAgentProposals(root)).toEqual([]);
    const again = await bridge.call("cancel_saved_agent_proposal", { id, reason: "no longer needed" });
    expect(again.isError).toBeFalsy();
    expect(JSON.stringify(again.content)).toContain("already gone");
  });
});

describe("readAgentProfileGrants fails closed (SDD 482 phase 4B)", () => {
  it("answers 'not granted' for missing, invalid and non-conforming profiles", () => {
    const root = workspace();
    expect(readAgentProfileGrants(root, "absent")).toBeUndefined();

    const dir = path.join(root, ".tachyon", "agents", "broken");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "agent.yml"), "runtime: [not, a, map\n", "utf8");
    expect(readAgentProfileGrants(root, "broken")).toBeUndefined();

    profile(root, "plain");
    expect(readAgentProfileGrants(root, "plain")).toEqual({});
    profile(root, "granted", { proposeSavedAgent: true });
    expect(readAgentProfileGrants(root, "granted")).toEqual({ proposeSavedAgent: true });
  });
});

/**
 * SDD 482 phase 4C — the roster reaches admission through the Bridge, rebuilt from the rows the
 * Bridge already has. `declaredOwner` is DERIVED from `subagents` at config load, so inverting it
 * reconstructs the same relation rather than reading a second source that could disagree.
 *
 * v1 has no `owns_subagents` input at all: the proposer becomes the new agent's declared owner, and
 * reparenting anyone else is a separate roster edit. So what the roster guards here is the ONE edge an
 * approval will create.
 */
describe("propose_saved_agent validates the ownership it will create (SDD 482 phase 4C)", () => {
  function withRoster(root: string, rows: Array<{ name: string; kind?: "agent" | "terminal"; declaredOwner?: string }>) {
    const tools = new Map<string, { config: { inputSchema?: Record<string, unknown> }; handler: ToolHandler }>();
    const mcp = {
      registerTool: (name: string, config: { inputSchema?: Record<string, unknown> }, handler: ToolHandler) => {
        tools.set(name, { config, handler });
      },
    };
    registerTools(mcp as never, {
      workspaceRoot: root,
      caller: { kind: "agent", name: "claude-runtime" },
      manager: { list: async () => rows.map((r) => ({ kind: "agent", ...r })) },
    } as unknown as BridgeDeps);
    return {
      schema: () => JSON.stringify(tools.get("propose_saved_agent")?.config.inputSchema ?? {}),
      call: (args: Record<string, unknown>) => tools.get("propose_saved_agent")!.handler(args),
    };
  }

  it("offers no way to declare subagents at all", () => {
    const root = workspace();
    expect(withRoster(root, []).schema()).not.toContain("owns_subagents");
  });

  it("admits when the proposed name is free", async () => {
    const root = workspace();
    profile(root, "claude-runtime", { proposeSavedAgent: true });
    const accepted = await withRoster(root, [{ name: "boss" }]).call(PROPOSAL);
    expect(accepted.isError).toBeFalsy();
    expect(listSavedAgentProposals(root)).toHaveLength(1);
  });

  /**
   * The collision the synthetic roster entry must not hide: a name already taken by an OWNED agent.
   * The refusal comes from the shared spec 352 helper, so it is worded exactly as a Studio edit would
   * word it.
   */
  it("refuses a name already taken by an owned agent, naming that owner", async () => {
    const root = workspace();
    profile(root, "claude-runtime", { proposeSavedAgent: true });
    const refused = await withRoster(root, [
      { name: "boss" },
      { name: "importer", declaredOwner: "boss" },
    ]).call(PROPOSAL);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("already declared as a subagent of 'boss'");
    expect(listSavedAgentProposals(root)).toEqual([]);
  });

  it("refuses a name already taken by a terminal, by name rather than as 'not found'", async () => {
    const root = workspace();
    profile(root, "claude-runtime", { proposeSavedAgent: true });
    const refused = await withRoster(root, [{ name: "importer", kind: "terminal" }]).call(PROPOSAL);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("resolves to a terminal");
  });
});
