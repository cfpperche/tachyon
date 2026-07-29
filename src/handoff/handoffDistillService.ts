import { mayRestartInstance } from "../agents/agentInstancePolicy.js";
import type { ManagedEntryInfo, SpawnOptions } from "../agents/AgentManager.js";
import { sendManagedAgentInput, type ManagedAgentInputSource } from "../agents/agentInputService.js";
import type { SessionRecord } from "../resume/SessionLedger.js";
import type { HandoffDistillInputV1 } from "../runtime-api/handoffCommands.js";
import { parseHandoffDistillInputV1 } from "../runtime-api/handoffCommands.js";
import {
  buildDistillTargets,
  buildHandoffDistillCommand,
  buildHandoffDistillPrompt,
  resolveHandoffDistillProfile,
  type HandoffDistillRuntime,
  type HandoffDistillTargetRow,
} from "./distill.js";

export interface WorkspaceHandoffDistillSource extends ManagedAgentInputSource {
  manager: ManagedAgentInputSource["manager"] & {
    spawn(agent: string, options?: SpawnOptions): Promise<unknown>;
  };
  ledger: {
    all(): Map<string, SessionRecord>;
  };
  resumableAgents(): string[];
  resumeAgent(agent: string): Promise<void>;
}

export interface HandoffDistillOperations {
  listAgents(): Promise<ManagedEntryInfo[]>;
  resumableAgentNames(): ReadonlySet<string>;
  startDeclaredAgent(agent: string): Promise<void>;
  resumeAgent(agent: string): Promise<void>;
  startAdhocAgent(agent: string, command: string, prompt: string): Promise<void>;
  sendAgentInput(agent: string, prompt: string): Promise<void>;
}

export interface HandoffDistillServiceOptions {
  now?: () => number;
  randomSuffix?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

export interface HandoffDistillResult {
  mode: HandoffDistillInputV1["mode"];
  agent: string;
}

const DEFAULT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_READY_POLL_MS = 250;

export function workspaceHandoffDistillOperations(
  source: WorkspaceHandoffDistillSource,
  options: { reveal: boolean },
): HandoffDistillOperations {
  return {
    listAgents: () => source.manager.list(),
    resumableAgentNames: () => {
      const names = new Set(source.resumableAgents());
      for (const [name, record] of source.ledger.all()) if (record.resume) names.add(name);
      return names;
    },
    startDeclaredAgent: async (agent) => { await source.manager.spawn(agent, { reveal: options.reveal }); },
    resumeAgent: (agent) => source.resumeAgent(agent),
    startAdhocAgent: async (agent, command, prompt) => {
      await source.manager.spawn(agent, {
        cmd: command,
        instructions: prompt,
        reveal: options.reveal,
      });
    },
    // SDD 480 — the minted turnId is discarded here on purpose: this adapter's contract is
    // `Promise<void>` and distillation has no use for the id. The turn is still recorded at the seam.
    sendAgentInput: async (agent, prompt) => { await sendManagedAgentInput(source, agent, prompt, true); },
  };
}

/** Declared agents in any state plus live ad-hoc AI agents, using one authority-owned list. */
export async function listHandoffDistillTargets(
  operations: Pick<HandoffDistillOperations, "listAgents" | "resumableAgentNames">,
): Promise<HandoffDistillTargetRow[]> {
  return buildDistillTargets(await operations.listAgents(), operations.resumableAgentNames());
}

/** One idempotency-keyed daemon command owns selection, lifecycle transition and prompt delivery. */
export async function startHandoffDistillation(
  operations: HandoffDistillOperations,
  rawInput: unknown,
  options: HandoffDistillServiceOptions = {},
): Promise<HandoffDistillResult> {
  const input = parseHandoffDistillInputV1(rawInput);
  const prompt = buildHandoffDistillPrompt({ additionalInstruction: input.instructions });
  if (input.mode === "existing") {
    const target = (await listHandoffDistillTargets(operations)).find((candidate) => candidate.name === input.agent);
    if (!target) throw new Error(`agent '${input.agent}' is not a handoff distillation target`);
    await ensureAgentLive(operations, input.agent, options);
    await operations.sendAgentInput(input.agent, prompt);
    return { mode: input.mode, agent: input.agent };
  }

  const profile = resolveHandoffDistillProfile(input.profileId);
  if (!profile) throw new Error(`unsupported handoff distillation profile '${input.profileId}'`);
  const agent = await uniqueDistillAgentName(operations, profile.runtime, options);
  await operations.startAdhocAgent(agent, buildHandoffDistillCommand(profile, input.args), prompt);
  return { mode: input.mode, agent };
}

async function ensureAgentLive(
  operations: HandoffDistillOperations,
  agent: string,
  options: HandoffDistillServiceOptions,
): Promise<void> {
  const current = (await operations.listAgents()).find((candidate) => candidate.name === agent);
  if (!current || current.kind !== "agent") throw new Error(`agent '${agent}' is not a managed AI agent`);
  if (isLive(current)) return;
  if (operations.resumableAgentNames().has(agent)) await operations.resumeAgent(agent);
  // SDD 482 phase 3 — "may it be started again from its own definition?" A fork could always be
  // resumed; under `declared` it read as if it could not.
  else if (mayRestartInstance(current)) await operations.startDeclaredAgent(agent);
  else throw new Error(`agent '${agent}' is stopped and cannot be resumed or respawned`);

  const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollMs = options.readyPollMs ?? DEFAULT_READY_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  do {
    const row = (await operations.listAgents()).find((candidate) => candidate.name === agent);
    if (row && row.kind === "agent" && isLive(row)) return;
    if (now() >= deadline) break;
    await sleep(pollMs);
  } while (true);
  throw new Error(`agent '${agent}' did not become ready in time for handoff distillation`);
}

async function uniqueDistillAgentName(
  operations: Pick<HandoffDistillOperations, "listAgents">,
  runtime: HandoffDistillRuntime,
  options: HandoffDistillServiceOptions,
): Promise<string> {
  const existing = new Set((await operations.listAgents()).map((agent) => agent.name));
  const now = options.now ?? Date.now;
  const base = `handoff-${runtime}-${now().toString(36).slice(-6)}`;
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 20; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  const random = (options.randomSuffix?.() ?? Math.random().toString(36).slice(2, 6))
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8) || "next";
  return `${base}-${random}`;
}

function isLive(row: Pick<ManagedEntryInfo, "running" | "dead" | "stopping">): boolean {
  return row.running && !row.dead && !row.stopping;
}
