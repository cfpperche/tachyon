import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { AgentManager, type DeliveryJoinRequest } from "../../src/agents/AgentManager.js";
import { asAgent, parseConfig, type ManagedEntryDef } from "../../src/config/loadConfig.js";
import { TmuxService, TmuxError, workspaceHash } from "../../src/tmux/TmuxService.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { agentLogId } from "../../src/activity/logStore.js";
import { sessionOwnersFile, spawnSettingsPath } from "../../src/activity/sessionOwners.js";

/** A real production-facing fixture retained by the immutable behavior gate. */
export async function exerciseBoundDeliveryExecution(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-bound-delivery-"));
  const sessions = new Set<string>();
  const minted: string[] = [], revoked: string[] = [], failed: string[] = [], killed: string[] = [], callbacks: string[] = [];
  let rejectReadiness = false;
  let rejectConfirmation = false;
  let rejectExtraEnv = false;
  let rejectMaterialization = false;
  const tmux = new TmuxService(async (args) => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) { sessions.add(args[args.indexOf("-s") + 1]!); return { stdout: "", stderr: "" }; }
    if (args.includes("kill-session")) { killed.push(target()); sessions.delete(target()); return { stdout: "", stderr: "" }; }
    if (args[2] === "has-session") { if (sessions.has(target())) return { stdout: "", stderr: "" }; throw new Error("no session"); }
    if (args[2] === "capture-pane" || args[2] === "list-sessions" || args[2] === "list-panes") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  try {
    const config = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    role: reviewer\n    instructions: durable reviewer\n    env:\n      MODE: strict\n    isolate: transcript\n").config!;
    const ledger = new SessionLedger(root);
    const home = (name: string) => path.join(root, ".tachyon", "harness", name);
    const manager = new AgentManager({
      tmux, wsHash: workspaceHash(root), workspaceRoot: root, getConfig: () => config, ledger,
      mintAgentToken: name => { minted.push(name); return { TACHYON_AGENT_BRIDGE_TOKEN: `token-${name}` }; },
      revokeAgentToken: name => { revoked.push(name); },
      getExtraEnv: () => { if (rejectExtraEnv) throw new Error("extra env failed"); return {}; },
      onKilled: name => { callbacks.push(name); },
      materializeHarness: ({ name }) => { if (rejectMaterialization) throw new Error("materializer failed"); const dir = home(name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "marker"), name); return { home: dir, env: { CODEX_HOME: dir }, args: [] }; },
      removeHarnessHome: name => fs.rmSync(home(name), { recursive: true, force: true }),
      prepareDeliveryJoin: async (name, request) => {
        if (name === "racing-live" || name === "racing-dead") sessions.add(manager.session(name));
        return { cwd: root, worktree: { path: root, branch: "delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" };
      },
      confirmDeliveryJoin: async () => { if (rejectConfirmation) throw new Error("confirmation failed"); },
      failDeliveryJoin: async name => { failed.push(name); },
      launchReadiness: { wait: async () => rejectReadiness ? { state: "rejected", code: "runtime_auth_rejected" } : { state: "ready" } },
    });
    await manager.spawn("reviewer");
    const principal = structuredClone(ledger.get("reviewer"));
    const principalHome = fs.readFileSync(path.join(home("reviewer"), "marker"));
    // Keep byte snapshots rather than object aliases: a delivery execution must
    // never rewrite the principal's persisted identity while it is created or
    // subsequently torn down.
    const principalBytes = Buffer.from(JSON.stringify(principal));
    sessions.add(manager.session("colliding-execution"));
    await expect(manager.spawn("colliding-execution", { taskBrief: "Bridge contract", deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "collision", declaredAgent: "reviewer" } })).rejects.toThrow("already in use");
    expect(sessions.size).toBe(2);
    expect(revoked).toEqual([]);
    expect(ledger.get("reviewer")).toEqual(principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(principalHome);

    // Preparation has no acquisition authority.  Both a live and a dead-pane
    // collision injected after the outer checks survive untouched.
    const beforeRace = { revoked: [...revoked], killed: [...killed], callbacks: [...callbacks], principal: structuredClone(ledger.get("reviewer")), home: fs.readFileSync(path.join(home("reviewer"), "marker")) };
    for (const name of ["racing-live", "racing-dead"]) {
      await expect(manager.spawn(name, { taskBrief: "Bridge contract", deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: name, declaredAgent: "reviewer" } })).rejects.toThrow("already in use");
      expect(sessions.has(manager.session(name))).toBe(true);
    }
    expect({ revoked, killed, callbacks }).toEqual({ revoked: beforeRace.revoked, killed: beforeRace.killed, callbacks: beforeRace.callbacks });
    expect(ledger.get("reviewer")).toEqual(beforeRace.principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(beforeRace.home);
    sessions.delete(manager.session("racing-live"));
    sessions.delete(manager.session("racing-dead"));

    await manager.kill("reviewer");
    // Prospective-home materialization now precedes token minting so preflight sees the exact
    // environment. A materializer failure therefore has no new token to revoke and must preserve
    // the principal's prior transient, lineage, durable row/home, and callback history.
    const internals = manager as unknown as { readyAgents: Set<string>; lineage: Map<string, string>; adhoc: Map<string, unknown> };
    internals.readyAgents.add("reviewer");
    internals.lineage.set("reviewer", "incumbent");
    const beforeMaterializerFailure = { callbacks: [...callbacks], revoked: [...revoked], principal: structuredClone(ledger.get("reviewer")), home: fs.readFileSync(path.join(home("reviewer"), "marker")) };
    rejectMaterialization = true;
    await expect(manager.spawn("reviewer", { deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "materializer" } })).rejects.toThrow("materializer failed");
    rejectMaterialization = false;
    expect(callbacks).toEqual(beforeMaterializerFailure.callbacks);
    expect(revoked).toEqual(beforeMaterializerFailure.revoked);
    expect(internals.readyAgents.has("reviewer")).toBe(true);
    expect(internals.lineage.get("reviewer")).toBe("incumbent");
    expect(ledger.get("reviewer")).toEqual(beforeMaterializerFailure.principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(beforeMaterializerFailure.home);
    rejectConfirmation = true;
    await expect(manager.spawn("reviewer", { deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "declared" } })).rejects.toThrow("confirmation failed");
    rejectConfirmation = false;
    expect(sessions.size).toBe(1);
    expect(revoked).toEqual(["reviewer", "reviewer"]);
    expect(ledger.get("reviewer")).toEqual(principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(principalHome);
    expect(callbacks).toEqual(["reviewer", "reviewer"]);
    // `getExtraEnv` fails before minting, so an already-declared principal keeps
    // its token and durable identity byte-for-byte.
    const beforeExtraEnv = { revoked: [...revoked], callbacks: [...callbacks], principal: structuredClone(ledger.get("reviewer")), home: fs.readFileSync(path.join(home("reviewer"), "marker")) };
    rejectExtraEnv = true;
    await expect(manager.spawn("reviewer", { deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "extra-env" } })).rejects.toThrow("extra env failed");
    rejectExtraEnv = false;
    expect(revoked).toEqual(beforeExtraEnv.revoked);
    expect(callbacks).toEqual(beforeExtraEnv.callbacks);
    expect(ledger.get("reviewer")).toEqual(beforeExtraEnv.principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(beforeExtraEnv.home);
    await manager.spawn("review-execution", { taskBrief: "Bridge contract", deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "op", declaredAgent: "reviewer" } });
    expect(Buffer.from(JSON.stringify(ledger.get("reviewer")))).toEqual(principalBytes);
    expect(ledger.get("review-execution")?.declared).toBe(false);
    expect(minted).toEqual(["reviewer", "reviewer", "review-execution"]);
    expect(sessions.size).toBe(2);
    expect(fs.readFileSync(path.join(home("review-execution"), "marker"))).toEqual(Buffer.from("review-execution"));
    await manager.kill("review-execution");
    expect(sessions.has(manager.session("review-execution"))).toBe(false);
    expect(ledger.get("review-execution")).toBeUndefined();
    expect(fs.existsSync(home("review-execution"))).toBe(false);
    expect(Buffer.from(JSON.stringify(ledger.get("reviewer")))).toEqual(principalBytes);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(principalHome);
    rejectReadiness = true;
    await expect(manager.spawn("failed-execution", { taskBrief: "Bridge contract", deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "op2", declaredAgent: "reviewer" } })).rejects.toThrow("runtime_auth_rejected");
    expect(sessions.size).toBe(1);
    expect(revoked).toEqual(["reviewer", "reviewer", "review-execution", "failed-execution"]);
    expect(failed).toEqual(["racing-live", "racing-dead", "reviewer", "reviewer", "reviewer", "failed-execution"]);
    expect(callbacks).toEqual(["reviewer", "reviewer", "review-execution", "failed-execution"]);
    expect(ledger.get("failed-execution")).toBeUndefined();
    expect(fs.existsSync(home("failed-execution"))).toBe(false);
    expect(ledger.get("reviewer")).toEqual(principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(principalHome);
    const beforeCmdFailure = { failed: [...failed], revoked: [...revoked] };
    await expect(manager.spawn("failed-cmd", { cmd: "codex", taskBrief: "Bridge contract", deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "cmd-op" } })).rejects.toThrow("runtime_auth_rejected");
    expect(sessions.has(manager.session("failed-cmd"))).toBe(false);
    expect(revoked).toEqual([...beforeCmdFailure.revoked, "failed-cmd"]);
    expect(failed).toEqual([...beforeCmdFailure.failed, "failed-cmd"]);
    expect(ledger.get("failed-cmd")).toBeUndefined();
    expect(fs.existsSync(home("failed-cmd"))).toBe(false);
    expect(internals.adhoc.has("failed-cmd")).toBe(false);
    expect(internals.lineage.has("failed-cmd")).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** B1: a bound execution is a fresh ephemeral identity over a frozen declared definition. */
export async function exerciseBoundDeliveryIdentitySnapshot(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-bound-identity-"));
  const prepared = path.join(root, "prepared-delivery");
  const sessions = new Set<string>();
  const launches: Array<{ name: string; cmd: string; cwd: string; env: Record<string, string> }> = [];
  const materialized: Array<{ name: string; def: unknown; cwd: string }> = [];
  const preparations: Array<{ name: string; request: unknown; prepared: unknown }> = [];
  const confirmations: Array<{ name: string; request: unknown; prepared: unknown }> = [];
  const minted: string[] = [], revoked: string[] = [], hooks: string[] = [];
  const counters = { preflight: 0, boundPreflight: 0, prepare: 0, confirm: 0, resolveSpawnCwd: 0, materialize: 0 };
  const tmux = new TmuxService(async (args) => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1]!;
      sessions.add(name);
      const env: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) if (args[i] === "-e") {
        const [key, ...value] = args[++i]!.split("="); env[key!] = value.join("=");
      }
      launches.push({ name, cmd: args[args.length - 1]!, cwd: args[args.indexOf("-c") + 1]!, env });
      return { stdout: "", stderr: "" };
    }
    if (args.includes("kill-session")) { sessions.delete(target()); return { stdout: "", stderr: "" }; }
    if (args[2] === "has-session") { if (sessions.has(target())) return { stdout: "", stderr: "" }; throw new Error("no session"); }
    if (args[2] === "list-sessions" || args[2] === "list-panes" || args[2] === "capture-pane") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  try {
    fs.mkdirSync(prepared, { recursive: true });
    for (const file of ["old-rule.md", "new-rule.md"]) fs.writeFileSync(path.join(root, file), file);
    for (const dir of ["old-skill", "new-skill"]) { fs.mkdirSync(path.join(root, dir)); fs.writeFileSync(path.join(root, dir, "SKILL.md"), dir); }
    const config = parseConfig(`agents:\n  reviewer:\n    cmd: codex --model gpt-5\n    role: reviewer\n    instructions: durable reviewer\n    env:\n      MODE: old\n    isolate: transcript\n    watch: [old-watch]\n    attention:\n      enabled: true\n      silenceSec: 9\n      patterns: [old-attention]\n    harness:\n      inherit: none\n      mcp:\n        old-mcp:\n          command: old-mcp\n          args: [old-arg]\n          env:\n            OLD_SECRET: \${OLD_SECRET}\n      hooks:\n        SessionStart: [old-hook]\n      instructions: [old-rule.md]\n      skills: [old-skill]\n`).config!;
    const source = asAgent(config.agents.reviewer)!;
    // `rules` is a Claude-only parser field, but the Delivery clone must still
    // defend every nested definition field if a live config object changes.
    source.harness!.rules = ["old-rule.md"];
    const ledger = new SessionLedger(root);
    const home = (name: string) => path.join(root, ".tachyon", "harness", name);
    const manager = new AgentManager({
      tmux, wsHash: workspaceHash(root), workspaceRoot: root, getConfig: () => config, ledger,
      launchPreflight: { check: async (_command, env) => {
        counters.preflight++;
        if (env.TACHYON_AGENT_NAME === "review-execution") {
          counters.boundPreflight++;
          source.env = { MODE: "new" }; source.watch = ["new-watch"]; source.attention = { enabled: false, silenceSec: 99, patterns: ["new-attention"] };
          source.harness = { inherit: "none", mcp: { "new-mcp": { command: "new-mcp", args: ["new-arg"], env: { NEW_SECRET: "${NEW_SECRET}" } } }, hooks: { Stop: ["new-hook"] }, rules: ["new-rule.md"], instructions: ["new-rule.md"], skills: ["new-skill"] };
        }
        return { state: "supported", runtime: "codex", source: "fixture" };
      } },
      resolveSpawnCwd: async ({ name }) => {
        counters.resolveSpawnCwd++;
        if (name === "review-execution") throw new Error("bound execution must not resolve a fresh worktree");
        return { cwd: root };
      },
      mintAgentToken: name => { minted.push(name); return { TACHYON_AGENT_BRIDGE_TOKEN: `token-${name}` }; },
      revokeAgentToken: name => { revoked.push(name); },
      materializeHarness: ({ name, def, cwd }) => { counters.materialize++; materialized.push({ name, def: structuredClone(def), cwd }); const dir = home(name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "marker"), JSON.stringify(def)); return { home: dir, env: { CODEX_HOME: dir }, args: [`--harness-${name}`] }; },
      removeHarnessHome: name => fs.rmSync(home(name), { recursive: true, force: true }),
      materializeCodexSessionStartHookConfig: name => { hooks.push(name); const file = spawnSettingsPath(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name); return `hooks.SessionStart=${name}`; },
      prepareDeliveryJoin: async (name, request) => { counters.prepare++; const receipt = { cwd: prepared, worktree: { path: prepared, branch: "delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "reservation", segmentId: "seg-t14" }; preparations.push({ name, request: structuredClone(request), prepared: receipt }); return receipt; },
      confirmDeliveryJoin: async (name, request, receipt) => { counters.confirm++; confirmations.push({ name, request: structuredClone(request), prepared: receipt }); },
    });
    await manager.spawn("reviewer");
    expect(ledger.get("reviewer")).toMatchObject({ declared: true, cwd: root, resume: { configHome: home("reviewer") } });
    const activity = path.join(root, ".tachyon", "activity"); fs.mkdirSync(activity, { recursive: true });
    fs.writeFileSync(path.join(activity, `${agentLogId("reviewer")}.jsonl`), "principal activity\n");
    fs.writeFileSync(path.join(activity, `${agentLogId("reviewer")}.state.json`), "principal state\n");
    fs.writeFileSync(sessionOwnersFile(root), `${JSON.stringify({ agent: "reviewer", sessionId: "principal", transcriptPath: "principal", cwd: root, source: "test", ts: "now" })}\n`);
    const continuity = path.join(root, ".tachyon", "continuity"); fs.mkdirSync(continuity, { recursive: true }); fs.writeFileSync(path.join(continuity, "reviewer.md"), "principal continuity\n"); fs.writeFileSync(path.join(continuity, "reviewer.state.json"), "principal continuity state\n");
    const principalFiles = [ledger.path, path.join(home("reviewer"), "marker"), path.join(activity, `${agentLogId("reviewer")}.jsonl`), path.join(activity, `${agentLogId("reviewer")}.state.json`), sessionOwnersFile(root), spawnSettingsPath(root, "reviewer"), path.join(continuity, "reviewer.md"), path.join(continuity, "reviewer.state.json")];
    const principalSnapshot = principalFiles.map(file => [file, fs.readFileSync(file)] as const);
    const principalTokenHistory = [...minted];
    const principalTmux = structuredClone(launches.find(launch => launch.name === manager.session("reviewer"))!);

    await manager.spawn("review-execution", { taskBrief: "Bridge contract", deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: "b1", declaredAgent: "reviewer" } });
    const execution = launches.find(launch => launch.name === manager.session("review-execution"))!;
    expect(sessions).toEqual(new Set([manager.session("reviewer"), manager.session("review-execution")]));
    expect(counters).toEqual({ preflight: 2, boundPreflight: 1, prepare: 1, confirm: 1, resolveSpawnCwd: 1, materialize: 2 });
    expect(preparations).toHaveLength(1);
    expect(confirmations).toHaveLength(1);
    expect(preparations[0]).toMatchObject({ name: "review-execution", request: { principal: "reviewer" } });
    expect(confirmations[0]).toMatchObject({ name: "review-execution", request: { principal: "reviewer" }, prepared: preparations[0]!.prepared });
    expect(confirmations[0]!.prepared).toBe(preparations[0]!.prepared);
    expect(materialized.at(-1)).toMatchObject({ name: "review-execution", cwd: prepared, def: { env: { MODE: "old" }, isolate: "transcript", watch: ["old-watch"], attention: { enabled: true, silenceSec: 9, patterns: ["old-attention"] }, harness: { mcp: { "old-mcp": { command: "old-mcp", args: ["old-arg"], env: { OLD_SECRET: "${OLD_SECRET}" } }, }, hooks: { SessionStart: ["old-hook"] }, rules: ["old-rule.md"], instructions: ["old-rule.md"], skills: ["old-skill"] } } });
    expect(source).toMatchObject({ env: { MODE: "new" }, watch: ["new-watch"], attention: { enabled: false, silenceSec: 99, patterns: ["new-attention"] }, harness: { mcp: { "new-mcp": { command: "new-mcp" } }, hooks: { Stop: ["new-hook"] }, rules: ["new-rule.md"], skills: ["new-skill"] } });
    expect(execution).toMatchObject({ cwd: prepared, env: { MODE: "old", TACHYON_AGENT_NAME: "review-execution", TACHYON_AGENT_BRIDGE_TOKEN: "token-review-execution", CODEX_HOME: home("review-execution") } });
    expect(execution.cmd).toContain("--sandbox read-only"); expect(execution.cmd).toContain("durable reviewer"); expect(execution.cmd).toContain("Bridge contract"); expect(execution.cmd.indexOf("reviewer")).toBeLessThan(execution.cmd.indexOf("Bridge contract")); expect(hooks).toEqual(["reviewer", "review-execution"]);
    expect((await manager.list()).find(info => info.name === "review-execution")).toMatchObject({ declared: false });
    expect(ledger.get("review-execution")).toMatchObject({ declared: false, cwd: prepared, worktree: { path: prepared }, def: { cmd: "codex --sandbox read-only --model gpt-5" } });

    await manager.kill("review-execution");
    expect(sessions).toEqual(new Set([manager.session("reviewer")])); expect(revoked).toEqual(["review-execution"]); expect(minted).toEqual([...principalTokenHistory, "review-execution"]);
    expect(ledger.get("review-execution")).toBeUndefined(); expect(fs.existsSync(home("review-execution"))).toBe(false); expect(fs.existsSync(spawnSettingsPath(root, "review-execution"))).toBe(false);
    for (const [file, bytes] of principalSnapshot) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(launches.find(launch => launch.name === manager.session("reviewer"))).toEqual(principalTmux);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** B2: every refusal that precedes a Delivery reservation leaves every launch surface untouched. */
export const boundDeliveryPreReservationRefusals = [
  "unknown declared source",
  "terminal declared source",
  "same execution name",
  "configured execution-name collision",
  "ad-hoc execution-name collision",
  "ledger execution-name collision",
  "live tmux execution-name collision",
  "dead tmux execution-name collision",
  "reserved token in declared source",
  "cmd plus declared_agent",
  "principal plus declared_agent",
  "unsafe reviewer command",
  "failed launch preflight",
] as const;

export type BoundDeliveryPreReservationRefusal = typeof boundDeliveryPreReservationRefusals[number];

export async function exerciseBoundDeliveryPreReservationRefusal(kind: BoundDeliveryPreReservationRefusal): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-bound-refusal-"));
  const sessions = new Set<string>();
  const dead = new Set<string>();
  // Every member of this vector corresponds to an AgentManager dependency that
  // would mutate a launch surface.  Setup deliberately happens before `before`.
  const counters = {
    reservationPrepare: 0, reservationConfirm: 0, reservationFail: 0,
    tokenMint: 0, tokenRevoke: 0,
    harnessMaterialization: 0, mcpMaterialization: 0, ownershipSettings: 0,
    tmuxCreate: 0, tmuxKill: 0, ledgerWrites: 0, onSpawned: 0, onKilled: 0,
  };
  const tmux = new TmuxService(async (args) => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) { counters.tmuxCreate++; sessions.add(args[args.indexOf("-s") + 1]!); return { stdout: "", stderr: "" }; }
    if (args.includes("kill-session")) { counters.tmuxKill++; sessions.delete(target()); dead.delete(target()); return { stdout: "", stderr: "" }; }
    if (args[2] === "has-session") { if (sessions.has(target())) return { stdout: "", stderr: "" }; throw new Error("no session"); }
    if (args[2] === "capture-pane" || args[2] === "list-sessions" || args[2] === "list-panes") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  try {
    const config = parseConfig("agents:\n  reviewer:\n    cmd: claude\n    role: reviewer\n    isolate: transcript\n").config!;
    const ledger = new SessionLedger(root);
    const completeDef = (): ManagedEntryDef => ({ ...config.agents.reviewer! });
    ledger.record("principal", { def: completeDef(), cwd: root, declared: true });
    const activity = path.join(root, ".tachyon", "activity", `${agentLogId("principal")}.jsonl`);
    fs.mkdirSync(path.dirname(activity), { recursive: true }); fs.writeFileSync(activity, "principal activity\n");
    const activityBytes = fs.readFileSync(activity);
    const originalRecord = ledger.record.bind(ledger);
    ledger.record = ((...args: Parameters<SessionLedger["record"]>) => { counters.ledgerWrites++; return originalRecord(...args); }) as SessionLedger["record"];
    const manager = new AgentManager({
      tmux, wsHash: workspaceHash(root), workspaceRoot: root, getConfig: () => config, ledger,
      launchPreflight: { check: async () => kind === "failed launch preflight"
        ? { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "fixture" }
        : { state: "supported", runtime: "codex", source: "fixture" } },
      prepareDeliveryJoin: async (_name, request) => ({ reservation: ++counters.reservationPrepare, cwd: root, worktree: { path: root, branch: "delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => { counters.reservationConfirm++; },
      failDeliveryJoin: async () => { counters.reservationFail++; },
      mintAgentToken: () => { counters.tokenMint++; return { TACHYON_AGENT_BRIDGE_TOKEN: "minted" }; },
      revokeAgentToken: () => { counters.tokenRevoke++; },
      getExtraEnv: () => ({ TACHYON_BRIDGE_URL: "http://127.0.0.1:9/mcp" }),
      materializeHarness: () => { counters.harnessMaterialization++; return { home: path.join(root, "harness"), env: {}, args: [] }; },
      materializeBridgeMcp: () => { counters.mcpMaterialization++; return path.join(root, "bridge-mcp.json"); },
      materializeOwnershipSettings: () => { counters.ownershipSettings++; return path.join(root, "settings.json"); },
      onSpawned: () => { counters.onSpawned++; },
      onKilled: () => { counters.onKilled++; },
    });
    const internals = manager as unknown as { adhoc: Map<string, unknown> };
    const name = "execution";
    const join: DeliveryJoinRequest = { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: `b2-${kind}`, declaredAgent: "reviewer" };
    let options: Parameters<AgentManager["spawn"]>[1] = { deliveryJoin: join };
    switch (kind) {
      case "unknown declared source": join.declaredAgent = "missing"; break;
      case "terminal declared source": config.agents.reviewer!.kind = "terminal"; break;
      case "same execution name": join.declaredAgent = name; break;
      case "configured execution-name collision": config.agents[name] = completeDef(); break;
      case "ad-hoc execution-name collision": internals.adhoc.set(name, completeDef()); break;
      case "ledger execution-name collision": originalRecord(name, { def: completeDef(), cwd: root, declared: false }); break;
      case "live tmux execution-name collision": sessions.add(manager.session(name)); break;
      case "dead tmux execution-name collision": sessions.add(manager.session(name)); dead.add(manager.session(name)); break;
      case "reserved token in declared source": config.agents.reviewer!.env = { TACHYON_AGENT_BRIDGE_TOKEN: "forbidden" }; break;
      case "cmd plus declared_agent": options = { cmd: "codex", deliveryJoin: join }; break;
      case "principal plus declared_agent": join.principal = "principal"; break;
      case "unsafe reviewer command": config.agents.reviewer!.cmd = "codex --dangerously-bypass-approvals"; break;
      case "failed launch preflight": config.agents.reviewer!.cmd = "codex"; break;
    }
    const before = { counters: structuredClone(counters), principal: fs.readFileSync(ledger.path), activity: Buffer.from(activityBytes), sessions: new Set(sessions), dead: new Set(dead) };
    await expect(manager.spawn(name, options)).rejects.toBeInstanceOf(Error);
    // The vector, rather than error wording, proves that no launch effect ran.
    expect(counters).toEqual(before.counters);
    expect(fs.readFileSync(ledger.path)).toEqual(before.principal);
    expect(fs.readFileSync(activity)).toEqual(before.activity);
    expect(sessions).toEqual(before.sessions);
    expect(dead).toEqual(before.dead);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/**
 * T13 R3: ordinary declared-agent Delivery join must refresh bridgeClient to this
 * incarnation's wiring outcome without rewriting principal def/resume/worktree/cwd.
 * Forces preservesDeclaredLedger (mode declared + existing ledger row) while Bridge
 * wiring fails — the stale wired:true stamp must not survive.
 */
export async function exerciseDeclaredDeliveryJoinBridgeStampRefresh(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-t13-r3-stamp-"));
  const sessions = new Set<string>();
  const deliveryCwd = path.join(root, "delivery-cwd");
  fs.mkdirSync(deliveryCwd, { recursive: true });
  const tmux = new TmuxService(async (args) => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) { sessions.add(args[args.indexOf("-s") + 1]!); return { stdout: "", stderr: "" }; }
    if (args.includes("kill-session")) { sessions.delete(target()); return { stdout: "", stderr: "" }; }
    if (args[2] === "has-session") { if (sessions.has(target())) return { stdout: "", stderr: "" }; throw new Error("no session"); }
    if (args[2] === "capture-pane" || args[2] === "list-sessions" || args[2] === "list-panes") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  try {
    const config = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    role: reviewer\n    instructions: durable reviewer\n    isolate: transcript\n").config!;
    const ledger = new SessionLedger(root);
    const principalWorktree = {
      path: path.join(root, "principal-wt"),
      branch: "principal-branch",
      tachyonCreatedBranch: true as const,
      baseRef: "principal-base",
      createdAt: "earlier",
    };
    const principalDef = {
      cmd: "codex",
      kind: "agent" as const,
      instructions: "durable reviewer",
    };
    const principalResume = {
      runtime: "codex" as const,
      sessionId: "principal-session-stale",
    };
    const principalCwd = path.join(root, "principal-cwd");
    // Stale healthy stamp from a prior incarnation (boundGeneration 3, wired true).
    ledger.record("reviewer", {
      def: principalDef,
      resume: principalResume,
      worktree: principalWorktree,
      cwd: principalCwd,
      declared: true,
      bridgeClient: { boundGeneration: 3, wired: true },
    });
    const before = structuredClone(ledger.get("reviewer")!);
    expect(before.bridgeClient).toEqual({ boundGeneration: 3, wired: true });

    const manager = new AgentManager({
      tmux,
      wsHash: workspaceHash(root),
      workspaceRoot: root,
      getConfig: () => config,
      ledger,
      getBridgeGeneration: () => 9,
      // Failed wiring: no Bridge URL → withRuntimeBridge reports wired:false.
      getExtraEnv: () => ({}),
      materializeBridgeMcp: () => undefined,
      mintAgentToken: () => ({ TACHYON_AGENT_BRIDGE_TOKEN: "token-reviewer" }),
      revokeAgentToken: () => undefined,
      prepareDeliveryJoin: async (_name, request) => ({
        cwd: deliveryCwd,
        worktree: {
          path: deliveryCwd,
          branch: "delivery",
          tachyonCreatedBranch: true,
          baseRef: request.expectedHead,
          createdAt: "now",
        },
        reservationNonce: "n", segmentId: "seg-t14",
      }),
      confirmDeliveryJoin: async () => undefined,
      failDeliveryJoin: async () => undefined,
      materializeHarness: ({ name }) => {
        const dir = path.join(root, ".tachyon", "harness", name);
        fs.mkdirSync(dir, { recursive: true });
        return { home: dir, env: { CODEX_HOME: dir }, args: [] };
      },
      launchReadiness: { wait: async () => ({ state: "ready" as const }) },
    });

    // Ordinary declared Delivery join: deliveryJoin set, no cmd, no declared_agent.
    await manager.spawn("reviewer", {
      deliveryJoin: {
        deliveryId: "d-r3",
        role: "reviewer",
        ownsSubset: [],
        expectedHead: "head",
        operationId: "r3-stamp",
      },
    });

    const after = ledger.get("reviewer")!;
    // Principal identity fields must remain the durable declared row — only bridgeClient refreshes.
    expect(after.def).toEqual(before.def);
    expect(after.resume).toEqual(before.resume);
    expect(after.worktree).toEqual(before.worktree);
    expect(after.cwd).toEqual(before.cwd);
    expect(after.declared).toBe(true);
    // Current failed-wiring stamp replaces the stale wired:true from generation 3.
    expect(after.bridgeClient).toEqual({ boundGeneration: 9, wired: false });
    expect(sessions.has(manager.session("reviewer"))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * B3 (t-13c2b6): a Delivery-bound `newSession` failure is always treated as uncertain — a same-named
 * pane may have landed on the tmux server despite the reported error, so `cleanupFailedDeliveryExecution`
 * never probes or kills it, whether or not the fake tmux server actually created a phantom session
 * behind the failure. Only the receipt-owned token is revoked; footprint/ledger/callback state is
 * retained exactly like the session itself, and reservation compensation runs exactly once.
 */
export const boundDeliveryNewSessionFailureCases = [
  "newSession fails before any pane is created",
  "newSession throws after an ambiguous same-named pane race",
] as const;
export type BoundDeliveryNewSessionFailureCase = typeof boundDeliveryNewSessionFailureCases[number];

export async function exerciseBoundDeliveryNewSessionFailure(kind: BoundDeliveryNewSessionFailureCase): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-bound-newsession-fail-"));
  const sessions = new Set<string>();
  const revoked: string[] = [], failed: string[] = [], killed: string[] = [], callbacks: string[] = [];
  const hasSessionTargets: string[] = [];
  const execName = "review-execution";
  // eslint-disable-next-line prefer-const -- assigned after `tmux`, read only once the manager spawns (closure, not TDZ)
  let manager: AgentManager;
  const tmux = new TmuxService(async (args) => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1]!;
      if (name === manager.session(execName)) {
        if (kind === "newSession throws after an ambiguous same-named pane race") sessions.add(name);
        throw new Error("injected newSession failure");
      }
      sessions.add(name);
      return { stdout: "", stderr: "" };
    }
    if (args.includes("kill-session")) { killed.push(target()); sessions.delete(target()); return { stdout: "", stderr: "" }; }
    if (args[2] === "has-session") { hasSessionTargets.push(target()); if (sessions.has(target())) return { stdout: "", stderr: "" }; throw new Error("no session"); }
    if (args[2] === "capture-pane" || args[2] === "list-sessions" || args[2] === "list-panes") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  try {
    const config = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    role: reviewer\n    instructions: durable reviewer\n    isolate: transcript\n").config!;
    const ledger = new SessionLedger(root);
    const home = (name: string) => path.join(root, ".tachyon", "harness", name);
    manager = new AgentManager({
      tmux, wsHash: workspaceHash(root), workspaceRoot: root, getConfig: () => config, ledger,
      mintAgentToken: name => ({ TACHYON_AGENT_BRIDGE_TOKEN: `token-${name}` }),
      revokeAgentToken: name => { revoked.push(name); },
      onKilled: name => { callbacks.push(name); },
      materializeHarness: ({ name }) => { const dir = home(name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "marker"), name); return { home: dir, env: { CODEX_HOME: dir }, args: [] }; },
      removeHarnessHome: name => fs.rmSync(home(name), { recursive: true, force: true }),
      prepareDeliveryJoin: async (_name, request) => ({ cwd: root, worktree: { path: root, branch: "delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => undefined,
      failDeliveryJoin: async name => { failed.push(name); },
      launchReadiness: { wait: async () => ({ state: "ready" as const }) },
    });
    await manager.spawn("reviewer");
    const principal = structuredClone(ledger.get("reviewer"));
    const principalHome = fs.readFileSync(path.join(home("reviewer"), "marker"));

    const failure = await manager.spawn(execName, {
      taskBrief: "Bridge contract",
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: kind, declaredAgent: "reviewer" },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    const agg = failure as AggregateError;
    expect(agg.errors.map((error: Error) => error.message)).toEqual([
      "injected newSession failure",
      "Delivery execution session creation is uncertain; recovery state preserved",
    ]);
    expect(agg.message).toContain("compensation was incomplete");

    // The ambiguous pane is never probed or killed by cleanup — session creation uncertainty
    // preserves whatever the tmux server actually did, whether or not this fake landed a phantom
    // session. The two recorded probes are both pre-acquisition "already in use" collision checks
    // (spawnDeliveryJoin's declared_agent name check, then spawnCore's own forced-attempt check) —
    // cleanupFailedDeliveryExecution's "attempted" branch adds no probe of its own.
    expect(hasSessionTargets.filter((n) => n === manager.session(execName))).toEqual([manager.session(execName), manager.session(execName)]);
    expect(killed).toEqual([]);
    expect(callbacks).toEqual([]);
    // Receipt-owned token policy: only this attempt's own freshly-minted token is revoked, exactly once.
    expect(revoked).toEqual([execName]);
    // Reservation compensation runs exactly once.
    expect(failed).toEqual([execName]);
    // No durable ledger row was ever persisted for a join whose session never completed.
    expect(ledger.get(execName)).toBeUndefined();
    // Materialized harness state is retained rather than cleaned up: uncertainty covers this
    // attempt's whole footprint, not just the session, since a live process may still depend on it.
    expect(fs.existsSync(home(execName))).toBe(true);
    // The declared principal's identity is completely untouched by the failed execution attempt.
    expect(ledger.get("reviewer")).toEqual(principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(principalHome);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/**
 * B4 (t-13c2b6): once a Delivery-bound execution's session is proven "completed", every subsequent
 * cleanup phase in `cleanupFailedDeliveryExecution` (session probe, kill, post-kill probe, token
 * revoke, in-memory/footprint removal, killed callback) is independently fault-injected, alone and in
 * combination, to prove: exact stable `AggregateError` order/labels/causes; every later safe cleanup
 * attempt still runs even after an earlier one throws; and liveness that is never proven dead (an
 * initial-probe error, a surviving pane after a failed kill) retains ALL state — footprint, ledger row,
 * and callback — rather than guessing.
 */
export const boundDeliveryCleanupOrderingCases = [
  "initial session probe error",
  "kill error with a surviving pane",
  "post-kill session probe error",
  "token revoke error after a clean kill",
  "killed callback error after a clean kill",
  "combined kill, token-revoke and callback failures",
  "reservation compensation error alongside a surviving pane",
] as const;
export type BoundDeliveryCleanupOrderingCase = typeof boundDeliveryCleanupOrderingCases[number];

export async function exerciseBoundDeliveryCleanupOrdering(kind: BoundDeliveryCleanupOrderingCase): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-bound-cleanup-order-"));
  const sessions = new Set<string>();
  const killed: string[] = [], revoked: string[] = [], callbacks: string[] = [], failed: string[] = [];
  const execName = "review-execution";
  const alwaysSurvivesKinds: BoundDeliveryCleanupOrderingCase[] = [
    "kill error with a surviving pane",
    "reservation compensation error alongside a surviving pane",
  ];
  const killThrowsKinds: BoundDeliveryCleanupOrderingCase[] = [
    "kill error with a surviving pane",
    "combined kill, token-revoke and callback failures",
    "reservation compensation error alongside a surviving pane",
  ];
  let cleanupPhase = false;
  let probeCount = 0;
  // eslint-disable-next-line prefer-const -- assigned after `tmux`, read only once the manager spawns (closure, not TDZ)
  let manager: AgentManager;
  const tmux = new TmuxService(async (args) => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) { sessions.add(args[args.indexOf("-s") + 1]!); return { stdout: "", stderr: "" }; }
    if (args.includes("kill-session")) {
      if (cleanupPhase && target() === manager.session(execName)) {
        killed.push(execName);
        if (killThrowsKinds.includes(kind)) throw new Error("injected kill failure");
        sessions.delete(target());
        return { stdout: "", stderr: "" };
      }
      sessions.delete(target());
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      if (cleanupPhase && target() === manager.session(execName)) {
        probeCount += 1;
        if (kind === "initial session probe error" && probeCount === 1) {
          throw new TmuxError("timed out waiting for tmux has-session", args);
        }
        if (kind === "post-kill session probe error" && probeCount === 2) {
          throw new TmuxError("timed out waiting for tmux has-session", args);
        }
        if (alwaysSurvivesKinds.includes(kind)) return { stdout: "", stderr: "" }; // never proven dead
        if (probeCount === 1) return { stdout: "", stderr: "" }; // alive on the first probe
        throw new Error("no session"); // gone once a kill has been attempted
      }
      if (sessions.has(target())) return { stdout: "", stderr: "" };
      throw new Error("no session");
    }
    if (args[2] === "capture-pane" || args[2] === "list-sessions" || args[2] === "list-panes") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  try {
    const config = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    role: reviewer\n    instructions: durable reviewer\n    isolate: transcript\n").config!;
    const ledger = new SessionLedger(root);
    const home = (name: string) => path.join(root, ".tachyon", "harness", name);
    manager = new AgentManager({
      tmux, wsHash: workspaceHash(root), workspaceRoot: root, getConfig: () => config, ledger,
      mintAgentToken: name => ({ TACHYON_AGENT_BRIDGE_TOKEN: `token-${name}` }),
      revokeAgentToken: name => {
        revoked.push(name);
        if (name === execName && (kind === "token revoke error after a clean kill" || kind === "combined kill, token-revoke and callback failures")) {
          throw new Error("injected token revoke failure");
        }
      },
      onKilled: name => {
        callbacks.push(name);
        if (name === execName && (kind === "killed callback error after a clean kill" || kind === "combined kill, token-revoke and callback failures")) {
          throw new Error("injected killed-callback failure");
        }
      },
      materializeHarness: ({ name }) => { const dir = home(name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "marker"), name); return { home: dir, env: { CODEX_HOME: dir }, args: [] }; },
      removeHarnessHome: name => fs.rmSync(home(name), { recursive: true, force: true }),
      prepareDeliveryJoin: async (_name, request) => ({ cwd: root, worktree: { path: root, branch: "delivery", tachyonCreatedBranch: true, baseRef: request.expectedHead, createdAt: "now" }, reservationNonce: "n", segmentId: "seg-t14" }),
      confirmDeliveryJoin: async () => { cleanupPhase = true; throw new Error("confirmation failed"); },
      failDeliveryJoin: async (name) => {
        failed.push(name);
        if (kind === "reservation compensation error alongside a surviving pane") throw new Error("injected reservation compensation failure");
      },
      launchReadiness: { wait: async () => ({ state: "ready" as const }) },
    });
    await manager.spawn("reviewer");
    const principal = structuredClone(ledger.get("reviewer"));
    const principalHome = fs.readFileSync(path.join(home("reviewer"), "marker"));

    const failure = await manager.spawn(execName, {
      taskBrief: "Bridge contract",
      deliveryJoin: { deliveryId: "d", role: "reviewer", ownsSubset: [], expectedHead: "head", operationId: kind, declaredAgent: "reviewer" },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    const agg = failure as AggregateError;
    const messages = agg.errors.map((error: Error) => error.message);
    const byMessage = (message: string) => agg.errors.find((error: Error) => error.message === message);

    switch (kind) {
      case "initial session probe error":
        expect(messages).toEqual([
          "confirmation failed",
          "initial session probe failed",
          "failed Delivery execution may still be live; recovery state preserved",
        ]);
        expect(byMessage("initial session probe failed")?.cause).toMatchObject({ message: "timed out waiting for tmux has-session" });
        expect(probeCount).toBe(1);
        expect(killed).toEqual([]); // never attempted: liveness was never disproven
        expect(revoked).toEqual([execName]); // token revoke is unconditional
        expect(callbacks).toEqual([]); // unreached: state retained under unknown liveness
        expect(fs.existsSync(home(execName))).toBe(true);
        expect(ledger.get(execName)).toBeDefined();
        break;
      case "kill error with a surviving pane":
        expect(messages).toEqual([
          "confirmation failed",
          "session kill failed",
          "failed Delivery execution may still be live; recovery state preserved",
        ]);
        expect(byMessage("session kill failed")?.cause).toMatchObject({ message: "injected kill failure" });
        expect(probeCount).toBe(2);
        expect(killed).toEqual([execName]);
        expect(revoked).toEqual([execName]);
        expect(callbacks).toEqual([]); // unreached: the survivor is never proven dead
        expect(fs.existsSync(home(execName))).toBe(true);
        expect(ledger.get(execName)).toBeDefined();
        break;
      case "post-kill session probe error":
        expect(messages).toEqual([
          "confirmation failed",
          "post-kill session probe failed",
          "failed Delivery execution may still be live; recovery state preserved",
        ]);
        expect(byMessage("post-kill session probe failed")?.cause).toMatchObject({ message: "timed out waiting for tmux has-session" });
        expect(probeCount).toBe(2);
        expect(killed).toEqual([execName]); // the kill itself succeeded
        expect(callbacks).toEqual([]);
        expect(fs.existsSync(home(execName))).toBe(true);
        expect(ledger.get(execName)).toBeDefined();
        break;
      case "token revoke error after a clean kill":
        expect(messages).toEqual(["confirmation failed", "token revoke failed"]);
        expect(byMessage("token revoke failed")?.cause).toMatchObject({ message: "injected token revoke failure" });
        expect(probeCount).toBe(2);
        expect(killed).toEqual([execName]);
        expect(callbacks).toEqual([execName]); // every later safe attempt still runs
        expect(fs.existsSync(home(execName))).toBe(false); // footprint removal still ran
        expect(ledger.get(execName)).toBeUndefined();
        break;
      case "killed callback error after a clean kill":
        expect(messages).toEqual(["confirmation failed", "killed callback failed"]);
        expect(byMessage("killed callback failed")?.cause).toMatchObject({ message: "injected killed-callback failure" });
        expect(probeCount).toBe(2);
        expect(killed).toEqual([execName]);
        expect(revoked).toEqual([execName]);
        expect(fs.existsSync(home(execName))).toBe(false); // footprint was removed BEFORE the callback ran
        expect(ledger.get(execName)).toBeUndefined();
        break;
      case "combined kill, token-revoke and callback failures":
        expect(messages).toEqual([
          "confirmation failed",
          "session kill failed",
          "token revoke failed",
          "killed callback failed",
        ]);
        expect(byMessage("session kill failed")?.cause).toMatchObject({ message: "injected kill failure" });
        expect(byMessage("token revoke failed")?.cause).toMatchObject({ message: "injected token revoke failure" });
        expect(byMessage("killed callback failed")?.cause).toMatchObject({ message: "injected killed-callback failure" });
        expect(probeCount).toBe(2);
        expect(killed).toEqual([execName]);
        // Every later removal still ran exactly once despite three earlier-order failures.
        expect(fs.existsSync(home(execName))).toBe(false);
        expect(ledger.get(execName)).toBeUndefined();
        break;
      case "reservation compensation error alongside a surviving pane":
        expect(messages).toEqual([
          "confirmation failed",
          "session kill failed",
          "failed Delivery execution may still be live; recovery state preserved",
          "reservation compensation failed",
        ]);
        expect(byMessage("reservation compensation failed")?.cause).toMatchObject({ message: "injected reservation compensation failure" });
        expect(probeCount).toBe(2);
        expect(failed).toEqual([execName]); // compensation was attempted exactly once, even though it failed
        expect(callbacks).toEqual([]);
        expect(fs.existsSync(home(execName))).toBe(true); // nothing was proven dead; state is retained
        expect(ledger.get(execName)).toBeDefined();
        break;
    }
    // The declared principal is never touched by any executor-side cleanup chaos.
    expect(ledger.get("reviewer")).toEqual(principal);
    expect(fs.readFileSync(path.join(home("reviewer"), "marker"))).toEqual(principalHome);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
