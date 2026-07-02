export type HandoffDistillRuntime = "codex" | "claude";

export interface HandoffDistillProfileVM {
  id: string;
  runtime: HandoffDistillRuntime;
  label: string;
  command: string;
  note: string;
}

export const HANDOFF_DISTILL_PROFILES: HandoffDistillProfileVM[] = [
  { id: "codex:default", runtime: "codex", label: "Codex — uses CLI configured model", command: "codex", note: "Model comes from the Codex CLI configuration." },
  { id: "codex:gpt-5-codex", runtime: "codex", label: "Codex — gpt-5-codex", command: "codex -m gpt-5-codex", note: "Explicitly asks Codex for gpt-5-codex." },
  { id: "claude:default", runtime: "claude", label: "Claude — uses CLI configured model", command: "claude", note: "Model comes from the Claude CLI configuration." },
  { id: "claude:sonnet", runtime: "claude", label: "Claude — sonnet", command: "claude --model sonnet", note: "Explicitly asks Claude for sonnet." },
  { id: "claude:haiku", runtime: "claude", label: "Claude — haiku", command: "claude --model haiku", note: "Explicitly asks Claude for haiku." },
];

const MAX_ADDITIONAL_INSTRUCTION = 2000;

export function normalizeAdditionalInstruction(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\r\n?/g, "\n").slice(0, MAX_ADDITIONAL_INSTRUCTION);
}

export function isHandoffDistillRuntime(raw: unknown): raw is HandoffDistillRuntime {
  return raw === "codex" || raw === "claude";
}

export function resolveHandoffDistillProfile(raw: unknown): HandoffDistillProfileVM | undefined {
  return typeof raw === "string" ? HANDOFF_DISTILL_PROFILES.find((p) => p.id === raw) : undefined;
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
