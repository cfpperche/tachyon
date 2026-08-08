import type { AgentInstanceLifetime, AgentInstanceResumePolicy } from "../resume/SessionLedger.js";
export type HandoffDistillRuntime = "codex" | "claude";

export interface HandoffDistillProfileVM {
  id: string;
  runtime: HandoffDistillRuntime;
  label: string;
  command: string;
  note: string;
}

export const HANDOFF_DISTILL_PROFILES: HandoffDistillProfileVM[] = [
  { id: "codex:default", runtime: "codex", label: "Codex — runtime default", command: "codex", note: "Uses the local Codex CLI configuration. Add runtime arguments below to override." },
  { id: "claude:default", runtime: "claude", label: "Claude — runtime default", command: "claude", note: "Uses the local Claude CLI configuration. Add runtime arguments below to override." },
];

export const MAX_HANDOFF_ADDITIONAL_INSTRUCTION = 2000;
export const MAX_HANDOFF_TEMPORARY_ARGS = 500;

export function normalizeAdditionalInstruction(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\r\n?/g, "\n").slice(0, MAX_HANDOFF_ADDITIONAL_INSTRUCTION);
}

export function normalizeHandoffDistillArgs(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return "";
  return trimmed.slice(0, MAX_HANDOFF_TEMPORARY_ARGS).trim();
}

export function buildHandoffDistillCommand(profile: HandoffDistillProfileVM, args?: unknown): string {
  const suffix = normalizeHandoffDistillArgs(args);
  return suffix ? `${profile.command} ${suffix}` : profile.command;
}

export function isHandoffDistillRuntime(raw: unknown): raw is HandoffDistillRuntime {
  return raw === "codex" || raw === "claude";
}

export function resolveHandoffDistillProfile(raw: unknown, profiles: HandoffDistillProfileVM[] = HANDOFF_DISTILL_PROFILES): HandoffDistillProfileVM | undefined {
  return typeof raw === "string" ? profiles.find((p) => p.id === raw) : undefined;
}

export function buildHandoffDistillPrompt(opts: { additionalInstruction?: unknown } = {}): string {
  const extra = normalizeAdditionalInstruction(opts.additionalInstruction);
  return [
    "TASK: Assist the owner with Project Handoff distillation.",
    "",
    "Read the current handoff state with `get_project_handoff` before doing anything else.",
    "Use the returned canonical `body`, `revision`, `pending`, and `pending_through` as one consistent snapshot.",
    "",
    "Produce a proposed rewrite of the canonical handoff that folds in the pending notes. Preserve useful existing context, remove stale/duplicated detail, and keep the result concise enough to be used as the next-session project state.",
    "",
    "Do not call `set_project_handoff` immediately. First show the proposed canonical content to the human and ask for explicit approval.",
    "",
    "Only after approval, call `set_project_handoff` with:",
    "- `content`: the approved full canonical handoff body",
    "- `expected_revision`: the `revision` from the snapshot you read",
    "- `distilled_through`: the `pending_through` from the same snapshot",
    "",
    "If `set_project_handoff` reports a revision mismatch, stop and re-read with `get_project_handoff`; do not overwrite concurrent changes.",
    "",
    "Do not create a second pending-note queue or candidate file. The existing pending notes are the only queue.",
    ...(extra ? ["", "Additional owner instruction:", extra] : []),
  ].join("\n");
}

export type HandoffDistillMode = "existing" | "adhoc";

/** Live-pane vs stopped Saved agent (t-1ba76d). A Temporary one only appears while running. */
export type HandoffDistillTargetState = "running" | "resumable" | "stopped";

export interface HandoffDistillTargetRow {
  name: string;
  /** UI sublabel after the name, e.g. `running · saved`. */
  description: string;
  state: HandoffDistillTargetState;
  /** t-04052d — the DECLARED durability of this agent's definition, replacing the `declared` boolean. */
  lifetime: AgentInstanceLifetime;
  /**
   * The second axis, and it is load-bearing for eligibility rather than decorative.
   *
   * The rule is "a Temporary is a legal destination while its definition is still there". For a plain
   * Temporary that means WHILE RUNNING — its definition dies with the session. A FORK is also
   * `temporary`, but it is `restartable`: it owns a resume block, and phase 2 was required to keep its
   * definition reloading. Refusing it would collapse `lifetime` back into resume capability, which is
   * the whole defect this cut removes.
   */
  resumePolicy: AgentInstanceResumePolicy;
}

/** Minimal list() row fields the distill target builder needs (keeps pure helpers free of AgentManager). */
export interface DistillListRow {
  name: string;
  kind: string;
  running: boolean;
  dead?: boolean;
  stopping?: boolean;
  /**
   * The roster's resolved durability answer (`ManagedEntryInfo.lifetime`). Read here rather than the
   * raw instance policy on purpose: a Saved agent that has never been started has no ledger row at
   * all, and asking the policy directly would drop it from the handoff list entirely.
   */
  lifetime: AgentInstanceLifetime;
  /** The roster's resolved resume answer — see `HandoffDistillTargetRow.resumePolicy`. */
  resumePolicy: AgentInstanceResumePolicy;
}

/**
 * t-1ba76d — Distill "existing" targets: all **Saved** agents (running or not) plus live Temporary
 * agents. Order: running first, then resumable, then stopped (each group alpha by name).
 */
export function buildDistillTargets(
  rows: ReadonlyArray<DistillListRow>,
  resumableNames: ReadonlyArray<string> | ReadonlySet<string> = [],
): HandoffDistillTargetRow[] {
  const resumable = resumableNames instanceof Set ? resumableNames : new Set(resumableNames);
  const out: HandoffDistillTargetRow[] = [];
  for (const a of rows) {
    const live = a.running && !a.dead && !a.stopping;
    // t-04052d — BOTH AXES, because one cannot answer this.
    //
    // The rule is "is this agent's definition still there to hand work to?". A Saved one always is. A
    // Temporary one is while it runs — and ALSO when it is `restartable`, which is exactly and only the
    // fork: no durable Profile, but its own resume block, whose reload phase 2 was obliged to preserve.
    //
    // NOT expressible as "is it in `resumable`": that set is every row carrying a resume block, and
    // spawnCore writes one for EVERY adapter-backed start, Temporary included. Gating on it would make
    // every stopped Temporary a handoff target and erase the refusal this rule exists to be.
    const temporary = a.lifetime === "temporary";
    if (temporary && !live && a.resumePolicy !== "restartable") continue;
    let state: HandoffDistillTargetState;
    if (live) state = "running";
    else if (resumable.has(a.name)) state = "resumable";
    else state = "stopped";
    out.push({
      name: a.name,
      state,
      lifetime: a.lifetime,
      resumePolicy: a.resumePolicy,
      description: `${state} · ${a.lifetime}`,
    });
  }
  const rank = (s: HandoffDistillTargetState): number => (s === "running" ? 0 : s === "resumable" ? 1 : 2);
  out.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
  return out;
}

/**
 * t-4eb7c0 — keep Distill mode/agent selection valid after an async host refresh reposts distillTargets.
 * - No running targets ⇒ force adhoc (existing is disabled in the UI).
 * - existing + dead/missing agent ⇒ pick the first live target.
 * - adhoc while targets were empty, then targets appear ⇒ prefer existing (stale open→refresh path).
 * - adhoc with a deliberate choice while targets already exist ⇒ leave mode alone.
 */
export function reconcileDistillSelection(
  targets: ReadonlyArray<{ name: string }>,
  prev: { mode: HandoffDistillMode; agent: string },
): { mode: HandoffDistillMode; agent: string } {
  if (targets.length === 0) return { mode: "adhoc", agent: "" };
  const names = new Set(targets.map((t) => t.name));
  if (prev.mode === "existing") {
    if (names.has(prev.agent)) return { mode: "existing", agent: prev.agent };
    return { mode: "existing", agent: targets[0]!.name };
  }
  // Opened with a stale empty list (forced adhoc) then refresh filled targets — surface declared/running list.
  if (!prev.agent) return { mode: "existing", agent: targets[0]!.name };
  return { mode: "adhoc", agent: prev.agent };
}
