import type {
  AgentFocus,
  AgentVM,
  AgentStatus,
  Verify,
  ContinuityBadge,
  EvidenceBadge,
  PersistenceHookBadge,
  ModelSource,
} from "./types";
import type { EntryKind } from "../config/loadConfig.js";
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

/** Codex `-c key=value` (and quoted) config override — extract model id when key is `model`. */
function modelIdFromCodexConfigOverride(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const match = /^model=(.+)$/i.exec(token);
  if (!match) return undefined;
  const modelId = match[1]?.trim();
  return modelId || undefined;
}

function labelModel(runtime: ReturnType<typeof runtimeOf>, modelId: string | undefined): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) return undefined;
  return runtime ? modelLabelForRuntime(runtime, trimmed) : trimmed;
}

/** Whether a declared spawn command pinned an explicit model, and the raw token it pinned (t-140242/378). */
export interface DeclaredModelInfo {
  /** Raw model id/token as declared on the command line — undefined when no explicit flag matched. */
  id?: string;
  /** True for `--model`/`-m`/`-c model=`; false for a bare runtime falling back to its profile default. */
  explicit: boolean;
}

/**
 * The declared model id parsed from a spawn command line (t-140242/t-140a24/spec 378) — the SAME token scan
 * `modelFromCommand` uses for its label, exposed as the raw id + explicitness so callers (RuntimeOps'
 * `source` field, the observed/declared divergence check) don't each re-implement the scan (plan: "unify the
 * two parallel declared-parsers"). Leftmost token that resolves to a non-empty label wins.
 */
export function declaredModelFromCommand(cmd: string | undefined): DeclaredModelInfo {
  if (!cmd?.trim()) return { explicit: false };
  const tokens = tokenizeCommand(cmd);
  const runtime = runtimeOf(cmd);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--model" || token === "-m") {
      const id = tokens[i + 1];
      if (labelModel(runtime, id)) return { id: id!.trim(), explicit: true };
      continue;
    }
    if (token.startsWith("--model=")) {
      const id = token.slice("--model=".length);
      if (labelModel(runtime, id)) return { id: id.trim(), explicit: true };
      continue;
    }
    // Codex TOML override: `-c model=gpt-5.6-terra` (two tokens after shell tokenize)
    if (token === "-c") {
      const id = modelIdFromCodexConfigOverride(tokens[i + 1]);
      if (labelModel(runtime, id)) return { id, explicit: true };
      continue;
    }
  }
  return { explicit: false };
}

/**
 * Best-effort model label from a spawn command line.
 * Supports Claude/Grok `--model`/`-m`/`--model=`, and Codex fleet form `-c model=<id>`
 * (t-140a24). Leftmost explicit model wins; bare known runtimes fall back to profile default.
 */
export function modelFromCommand(cmd: string | undefined): string | undefined {
  if (!cmd?.trim()) return undefined;
  const runtime = runtimeOf(cmd);
  const declared = declaredModelFromCommand(cmd);
  if (declared.id) {
    const labeled = labelModel(runtime, declared.id);
    if (labeled) return labeled;
  }
  return runtime ? modelLabelForRuntime(runtime) : undefined;
}

/** spec 378 — an observed id from a transcript must be charset/length-gated before it's trusted as a label
 *  (transcripts are less trusted than a declared spawn command); never "Unavailable" for an unknown-but-valid
 *  id — `labelModel` already falls back to a raw/title-cased render. */
const OBSERVED_MODEL_ID_RE = /^[A-Za-z0-9 ._:/-]{1,64}$/;

export function validatedObservedModelId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed && OBSERVED_MODEL_ID_RE.test(trimmed) ? trimmed : undefined;
}

/** The transcript-latched observed model fact gathered by the host (spec 378) — raw, pre-precedence. */
export interface ObservedModelInput {
  /** Raw observed model id (validated internally before use). */
  id?: string;
  effort?: string;
  observedAt?: string;
  /** True when a process-preserving session boundary (in-TUI `/clear`, resume) was crossed since this
   *  observation, so it's carried forward but flagged as awaiting re-observation. */
  stale: boolean;
}

/** The resolved (label, source, stale, divergence) model fact for one agent row (spec 378). */
export interface ModelFact {
  label: string;
  source: ModelSource;
  observedAt?: string;
  stale: boolean;
  divergence: boolean;
}

/**
 * Precedence: observed > declared > profile (spec 378 acceptance). Divergence compares the declared and
 * observed LABELS (both normalized through the same alias table via `labelModel`/`modelLabelForRuntime`) —
 * not the raw ids, so e.g. a bare `codex` (declared: "Codex default") vs an observed `gpt-5.6-sol`
 * ("GPT-5.6 Sol") correctly reads as divergent. Boundary-aware demotion happens upstream (the caller clears
 * `observed.id` on a process-rotating boundary, or sets `stale: true` on a process-preserving one) — this
 * function only applies straightforward precedence to whatever it's given.
 */
export function resolveModelFact(cmd: string | undefined, observed?: ObservedModelInput): ModelFact | undefined {
  const declaredLabel = modelFromCommand(cmd);
  if (!declaredLabel || !cmd) return undefined;
  const declaredSource: ModelSource = declaredModelFromCommand(cmd).explicit ? "declared" : "profile";
  const runtime = runtimeOf(cmd);
  const validId = runtime ? validatedObservedModelId(observed?.id) : undefined;
  if (!validId) return { label: declaredLabel, source: declaredSource, stale: false, divergence: false };
  const observedLabel = labelModel(runtime, validId) ?? validId;
  return {
    label: observedLabel,
    source: "observed",
    ...(observed?.observedAt ? { observedAt: observed.observedAt } : {}),
    stale: observed?.stale === true,
    divergence: observedLabel !== declaredLabel,
  };
}
export interface AgentExtras {
  /** monitor attention state: "working" | "idle" | "needs-input" | "throttled" (undefined when not monitored) */
  attention?: string;
  /** isolation/config branch from the ledger worktree record (gates worktree actions). */
  worktree?: string;
  /** spec 384 — live HEAD branch at session cwd. */
  liveBranch?: string;
  /** spec 384 — live HEAD ≠ config/isolation branch. */
  branchDrift?: boolean;
  /** spec 384 — session cwd for tooltip. */
  worktreePath?: string;
  /** spec 386 — live resource sample for the pane subtree. */
  resources?: { cpuPct?: number; memMb: number };
  harness?: boolean;
  /** this agent IS a forked sibling (spec 225 def.fork) → ⑂ badge. */
  forked?: boolean;
  /** this agent CAN be forked (running claude) → offers the Fork action. */
  forkable?: boolean;
  resumable?: boolean;
  freshStart?: boolean;
  verify?: Verify;
  verifiable?: boolean;
  /** SDD 478 M5 — the managed-entry arm; absent means the caller had no entry to read. */
  kind?: EntryKind;
  adhoc?: boolean;
  continuity?: ContinuityBadge;
  /** spec 390 — glance focus line (task / brief / continuity). */
  focus?: AgentFocus;
  persistenceHooks?: { state: PersistenceHookBadge; reason?: string; path?: string; updatedAt?: string };
  evidence?: EvidenceBadge;
  externalTools?: ExternalToolsSummaryVM;
  canDismiss?: boolean;
  /** t-35d95a — AttentionMonitor.awaitingHuman latch (request_human_attention); undefined = not latched. */
  awaitingHuman?: { reason: string };
  /** SDD 477 / t-5bfb72 — the runtime says this agent is not authenticated; undefined = not latched.
   *  `action` is the measured human action, never credential material. */
  authRequired?: { runtime: string; action: string };
  /** t-a39c7d — idle turn finished and not yet focused by human (sidebar status "done"). */
  unseen?: boolean;
  /** t-8354ae — row rendered under invalid config (ledger/LKG degraded mode). */
  configInvalid?: boolean;
  /** spec 378 — the transcript-latched observed model fact (undefined = no observation yet; the row falls
   *  back to declared/profile). */
  model?: ObservedModelInput;
}

/** The sidebar grouping bucket. NOTE: mixes lifecycle (running/stopped/crashed) with running-attention
 *  (needs/idle) — matches the approved prototype; the lifecycle-vs-attention split is a tracked follow-up. */
export function statusOf(a: AgentRaw, attention?: string, unseen?: boolean): AgentStatus {
  if (a.dead) return a.crashed ? "crashed" : "stopped";
  if (a.stopping) return "stopping";
  if (a.stopFailed) return "stop-failed";
  if (!a.running) return "stopped";
  if (attention === "needs-input") return "needs";
  if (attention === "throttled") return "throttled";
  // t-a39c7d — done = idle + unseen (herdr); decays to idle after markSeen.
  if (attention === "idle" && unseen) return "done";
  if (attention === "idle") return "idle";
  return "running";
}

export function toAgentVM(a: AgentRaw, x: AgentExtras = {}): AgentVM {
  const alive = a.running && !a.dead && !a.cleanExited;
  const visibleAttention = alive ? x.attention : undefined;
  const visibleAwaitingHuman = alive ? x.awaitingHuman : undefined;
  const visibleAuthRequired = alive ? x.authRequired : undefined;
  const visibleUnseen = alive ? x.unseen === true : false;
  // spec 390 — never surface "working" as a badge (live-dot already means alive/busy).
  const attention =
    visibleAttention === "needs-input"
      ? "needs input"
      : visibleAttention === "throttled"
        ? "throttled"
        : visibleAttention === "idle" && visibleUnseen
          ? "done"
          : undefined;
  const sub = a.dead ? (a.crashed ? `exited (${a.exitCode ?? 1})` : "exited (0)") : a.cleanExited ? "exited (0)" : undefined;
  const stopping = a.stopping && !a.dead ? "stopping..." : undefined;
  const stopFailed = a.stopFailed && !a.dead ? "stop failed" : undefined;
  // A terminal runs a process, not a model. Any other arm (or an unknown one) still resolves.
  const modelFact = x.kind === "terminal" ? undefined : resolveModelFact(a.cmd, x.model);
  // SDD 479 phase 3 — the runtime this row runs on, so a per-runtime card template can match it.
  // Derived from the same command, by the same `runtimeOf`, that the model label already uses: the row
  // cannot report one runtime to the card and a different one to the model. A terminal has none by
  // construction — it runs a process, and V1 templates never reach terminal rows anyway.
  const runtime = x.kind === "terminal" ? null : runtimeOf(a.cmd ?? "");
  return {
    name: a.name,
    ...(runtime ? { runtime } : {}),
    ...(modelFact
      ? {
          model: modelFact.label,
          modelSource: modelFact.source,
          ...(modelFact.observedAt ? { modelObservedAt: modelFact.observedAt } : {}),
          ...(modelFact.stale ? { modelStale: true } : {}),
          ...(modelFact.divergence ? { modelDivergence: true } : {}),
        }
      : {}),
    status: statusOf(a, visibleAttention, visibleUnseen),
    ...(attention ? { attention } : {}),
    ...(a.parent ? { parent: a.parent } : {}),
    ...(a.delegator ? { delegator: a.delegator } : {}),
    ...(a.declaredOwner ? { declaredOwner: a.declaredOwner } : {}),
    ...(sub || stopping || stopFailed ? { sub: sub ?? stopping ?? stopFailed } : {}),
    ...((a.dead && !a.crashed) || a.cleanExited ? { exited: true } : {}),
    ...(a.cleanExited ? { pane: false } : {}),
    ...(x.worktree ? { worktree: x.worktree } : {}),
    ...(x.liveBranch ? { liveBranch: x.liveBranch } : {}),
    ...(x.branchDrift ? { branchDrift: true } : {}),
    ...(x.worktreePath ? { worktreePath: x.worktreePath } : {}),
    ...(x.resources ? { resources: x.resources } : {}),
    ...(x.verify ? { verify: x.verify } : {}),
    ...(x.harness ? { harness: true } : {}),
    ...(x.resumable ? { resumable: true } : {}),
    ...(x.freshStart ? { freshStart: true } : {}),
    ...(x.forked ? { forked: true } : {}),
    ...(x.forkable ? { forkable: true } : {}),
    kind: x.kind ?? "agent",
    ...(x.adhoc ? { adhoc: true } : {}),
    ...(x.verifiable ? { verifiable: true } : {}),
    ...(x.canDismiss ? { canDismiss: true } : {}),
    ...(x.continuity ? { continuity: x.continuity } : {}),
    ...(x.focus ? { focus: x.focus } : {}),
    ...(x.persistenceHooks ? { persistenceHooks: x.persistenceHooks } : {}),
    ...(x.evidence ? { evidence: x.evidence } : {}),
    ...(x.externalTools ? { externalTools: x.externalTools } : {}),
    ...(visibleAwaitingHuman ? { awaitingHuman: visibleAwaitingHuman } : {}),
    ...(visibleAuthRequired ? { authRequired: visibleAuthRequired } : {}),
    ...(x.configInvalid ? { configInvalid: true } : {}),
  };
}
