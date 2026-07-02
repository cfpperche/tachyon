export type HandoffDistillRuntime = "codex" | "claude";

export interface HandoffDistillProfileVM {
  id: string;
  runtime: HandoffDistillRuntime;
  label: string;
  command: string;
  note: string;
}

const CODEX_MODEL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;

const FALLBACK_CODEX_PROFILES: HandoffDistillProfileVM[] = [
  { id: "codex:default", runtime: "codex", label: "Codex — CLI configured model", command: "codex", note: "Uses the model from the local Codex configuration; may fail if that account cannot use it." },
];

const CLAUDE_PROFILES: HandoffDistillProfileVM[] = [
  { id: "claude:default", runtime: "claude", label: "Claude — uses CLI configured model", command: "claude", note: "Model comes from the Claude CLI configuration." },
  { id: "claude:sonnet", runtime: "claude", label: "Claude — sonnet", command: "claude --model sonnet", note: "Explicitly asks Claude for sonnet." },
  { id: "claude:haiku", runtime: "claude", label: "Claude — haiku", command: "claude --model haiku", note: "Explicitly asks Claude for haiku." },
];

export const HANDOFF_DISTILL_PROFILES: HandoffDistillProfileVM[] = [...FALLBACK_CODEX_PROFILES, ...CLAUDE_PROFILES];

export function handoffDistillProfilesFromCodexCatalog(catalog: unknown): HandoffDistillProfileVM[] {
  const root = catalog && typeof catalog === "object" ? catalog as { models?: unknown } : {};
  if (!Array.isArray(root.models)) return [];
  const seen = new Set<string>();
  return root.models.flatMap((m): HandoffDistillProfileVM[] => {
    if (!m || typeof m !== "object") return [];
    const model = m as { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_in_api?: unknown };
    const slug = typeof model.slug === "string" ? model.slug.trim() : "";
    if (!slug || seen.has(slug) || !CODEX_MODEL_ID_RE.test(slug)) return [];
    if (model.visibility !== "list" || model.supported_in_api === false) return [];
    seen.add(slug);
    const label = typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : slug;
    return [{
      id: `codex:model:${slug}`,
      runtime: "codex",
      label: `Codex — ${label}`,
      command: `codex --model ${slug}`,
      note: "Discovered from `codex debug models` for this installed Codex runtime.",
    }];
  });
}

export function buildHandoffDistillProfiles(opts: { codexCatalog?: unknown } = {}): HandoffDistillProfileVM[] {
  const discoveredCodex = handoffDistillProfilesFromCodexCatalog(opts.codexCatalog);
  return [...discoveredCodex, ...FALLBACK_CODEX_PROFILES, ...CLAUDE_PROFILES];
}

const MAX_ADDITIONAL_INSTRUCTION = 2000;

export function normalizeAdditionalInstruction(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\r\n?/g, "\n").slice(0, MAX_ADDITIONAL_INSTRUCTION);
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
