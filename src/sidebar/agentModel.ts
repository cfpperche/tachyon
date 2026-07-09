import type { AgentVM, AgentStatus, Verify, ContinuityBadge, EvidenceBadge, PersistenceHookBadge } from "./types";
import type { ExternalToolsSummaryVM } from "../externalTools/types.js";
import { runtimeOf } from "../resume/adapters.js";
import { modelLabelForRuntime } from "../runtime/runtimeProfile.js";

/**
 * spec 237 — pure agent-model mapper (no vscode, no preact). The provider gathers raw fleet state from
 * the managers and calls this to produce the typed `AgentVM` the Preact UI renders. Unit-tested.
 */
export interface AgentRaw {
  name: string;
  cmd?: string;
  running: boolean;
  stopping?: boolean;
  stopFailed?: boolean;
  dead: boolean;
  crashed: boolean;
  exitCode?: number;
  cleanExited?: boolean;
  parent?: string;
  delegator?: string;
  declaredOwner?: string;
}

function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const ch of cmd.trim()) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (escaped) cur += "\\";
  if (cur) out.push(cur);
  return out;
}

export function modelFromCommand(cmd: string | undefined): string | undefined {
  if (!cmd?.trim()) return undefined;
  const tokens = tokenizeCommand(cmd);
  const runtime = runtimeOf(cmd);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--model" || token === "-m") return runtime ? modelLabelForRuntime(runtime, tokens[i + 1]) : tokens[i + 1]?.trim() || undefined;
    if (token.startsWith("--model=")) {
      const modelId = token.slice("--model=".length);
      return runtime ? modelLabelForRuntime(runtime, modelId) : modelId.trim() || undefined;
    }
  }
  return runtime ? modelLabelForRuntime(runtime) : undefined;
}
export interface AgentExtras {
  /** monitor attention state: "working" | "idle" | "needs-input" | "throttled" (undefined when not monitored) */
  attention?: string;
  worktree?: string; // branch name
  harness?: boolean;
  /** this agent IS a forked sibling (spec 225 def.fork) → ⑂ badge. */
  forked?: boolean;
  /** this agent CAN be forked (running claude) → offers the Fork action. */
  forkable?: boolean;
  resumable?: boolean;
  freshStart?: boolean;
  verify?: Verify;
  verifiable?: boolean;
  ai?: boolean;
  adhoc?: boolean;
  continuity?: ContinuityBadge;
  persistenceHooks?: { state: PersistenceHookBadge; reason?: string; path?: string; updatedAt?: string };
  evidence?: EvidenceBadge;
  externalTools?: ExternalToolsSummaryVM;
  canDismiss?: boolean;
  /** t-35d95a — AttentionMonitor.awaitingHuman latch (request_human_attention); undefined = not latched. */
  awaitingHuman?: { reason: string };
}

/** The sidebar grouping bucket. NOTE: mixes lifecycle (running/stopped/crashed) with running-attention
 *  (needs/idle) — matches the approved prototype; the lifecycle-vs-attention split is a tracked follow-up. */
export function statusOf(a: AgentRaw, attention?: string): AgentStatus {
  if (a.dead) return a.crashed ? "crashed" : "stopped";
  if (a.stopping) return "stopping";
  if (a.stopFailed) return "stop-failed";
  if (!a.running) return "stopped";
  if (attention === "needs-input") return "needs";
  if (attention === "throttled") return "throttled";
  if (attention === "idle") return "idle";
  return "running";
}

export function toAgentVM(a: AgentRaw, x: AgentExtras = {}): AgentVM {
  const alive = a.running && !a.dead && !a.cleanExited;
  const visibleAttention = alive ? x.attention : undefined;
  const visibleAwaitingHuman = alive ? x.awaitingHuman : undefined;
  const attention = visibleAttention === "needs-input" ? "needs input" : visibleAttention === "throttled" ? "throttled" : visibleAttention === "working" ? "working" : undefined;
  const sub = a.dead ? (a.crashed ? `exited (${a.exitCode ?? 1})` : "exited (0)") : a.cleanExited ? "exited (0)" : undefined;
  const stopping = a.stopping && !a.dead ? "stopping..." : undefined;
  const stopFailed = a.stopFailed && !a.dead ? "stop failed" : undefined;
  const model = x.ai === false ? undefined : modelFromCommand(a.cmd);
  return {
    name: a.name,
    ...(model ? { model } : {}),
    status: statusOf(a, visibleAttention),
    ...(attention ? { attention } : {}),
    ...(a.parent ? { parent: a.parent } : {}),
    ...(a.delegator ? { delegator: a.delegator } : {}),
    ...(a.declaredOwner ? { declaredOwner: a.declaredOwner } : {}),
    ...(sub || stopping || stopFailed ? { sub: sub ?? stopping ?? stopFailed } : {}),
    ...((a.dead && !a.crashed) || a.cleanExited ? { exited: true } : {}),
    ...(a.cleanExited ? { pane: false } : {}),
    ...(x.worktree ? { worktree: x.worktree } : {}),
    ...(x.verify ? { verify: x.verify } : {}),
    ...(x.harness ? { harness: true } : {}),
    ...(x.resumable ? { resumable: true } : {}),
    ...(x.freshStart ? { freshStart: true } : {}),
    ...(x.forked ? { forked: true } : {}),
    ...(x.forkable ? { forkable: true } : {}),
    ...(x.ai ? { ai: true } : {}),
    ...(x.adhoc ? { adhoc: true } : {}),
    ...(x.verifiable ? { verifiable: true } : {}),
    ...(x.canDismiss ? { canDismiss: true } : {}),
    ...(x.continuity ? { continuity: x.continuity } : {}),
    ...(x.persistenceHooks ? { persistenceHooks: x.persistenceHooks } : {}),
    ...(x.evidence ? { evidence: x.evidence } : {}),
    ...(x.externalTools ? { externalTools: x.externalTools } : {}),
    ...(visibleAwaitingHuman ? { awaitingHuman: visibleAwaitingHuman } : {}),
  };
}
