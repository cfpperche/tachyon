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

const MAX_ADDITIONAL_INSTRUCTION = 2000;
const MAX_ADHOC_ARGS = 500;

export function normalizeAdditionalInstruction(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\r\n?/g, "\n").slice(0, MAX_ADDITIONAL_INSTRUCTION);
}

export function normalizeHandoffDistillArgs(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return "";
  return trimmed.slice(0, MAX_ADHOC_ARGS).trim();
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
  // Opened with a stale empty list (forced adhoc) then refresh filled targets — surface Running agent.
  if (!prev.agent) return { mode: "existing", agent: targets[0]!.name };
  return { mode: "adhoc", agent: prev.agent };
}
