# 344 — validation-queue-governance — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Define a project-local Validation entity with a lifecycle optimized for "prove this works" work, not implementation work. Keep it independent from SDD by using open source links/artifact references, following the existing Task design pattern from spec 325.

Proposed model:

```ts
Validation {
  id: "v-<hex>";
  title: string;
  type?: string; // open project-defined label: dogfood, install check, red-team pass, etc.
  status: "pending" | "triaged" | "running" | "closed";
  executor: "human" | "agent" | "either";
  priority?: 0 | 1 | 2 | 3;
  assignee?: string; // open string, including "human" or agent names
  instructions?: string;
  source_refs?: ArtifactRef[];
  rounds: ValidationRound[];
  author: string;
  createdAt: string;
  updatedAt: string;
}

ValidationRound {
  n: number;
  startedAt?: string;
  closedAt?: string;
  assignee?: string;
  outcome?: "passed" | "failed" | "skipped";
  evidence_refs?: ArtifactRef[];
  result_note?: string;
}
```

The only closed fields are lifecycle/mechanical fields Tachyon needs to operate safely (`status`, `executor`, round `outcome`, priority range). The project-specific semantic label remains open (`type?: string`), matching Task `kind` and `artifact_refs` decisions.

Status answers "where is this validation in the queue now?" Outcome answers "what happened in a completed round?" A failed validation can be reopened into a new round without losing the earlier failure evidence. This avoids overloading `failed` as both current state and historical result.

V1 should expose Bridge tools and Mission Control UI:

- Bridge: create/list/get/update/claim/close for validations, with evidence/note-required closure.
- Mission Control: a compact "Validations" signal/closure strip showing pending human/agent/either items and reviewable candidates, plus a default-view pending badge/signal.
- Discovery/import: scan existing Tachyon-owned text sources (pins, tasks, specs if present) for pending dogfood/manual validation debt and produce reviewable validation candidates. This reads conventions opportunistically; it does not require the SDD plugin.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Name is Validation, not Dogfood** — chosen because it covers human dogfood, agent checks, QA, install checks, and project-specific proof; rejected Dogfood as the top-level product noun because it is informal and narrower.
- **Open `type` label** — chosen because projects have their own validation rituals; rejected closed validation-kind enums because recent Task design deliberately avoided rigid workflow labels.
- **Closed lifecycle fields only where Tachyon operates them** — chosen because status/executor need predictable behavior for filtering, claiming, and safety; rejected fully free-form status because Mission Control needs a reliable pending/running/closed distinction.
- **Standalone entity, initially** — chosen because validations can outlive or cross-cut tasks/specs/pins and need evidence-first closure; rejected Task subtype for v1 because it would overload implementation-task semantics.
- **Status and outcome are separate** — chosen because a failed validation may be fixed and re-run; rejected `status:"failed"` as a terminal state because it overwrites round history or makes retry semantics ambiguous.
- **No `owner` field** — chosen because `executor` says who can perform the validation and `assignee` says who currently owns it; rejected parallel owner/assignee fields as redundant.
- **No `blocksRelease` in v1** — chosen because release policy needs its own later design; rejected boolean release blocking now because it implies enforcement Tachyon will not ship in this spec.
- **Mission Control owns visibility** — chosen because the problem is governance across project work; rejected hiding validations inside SDD notes because projects may not use SDD.

## Files touched

- `src/validations/types.ts` — Validation types, status/executor constants, open artifact refs.
- `src/validations/ValidationStore.ts` — project-local durable store under `.tachyon/validations/`.
- `src/validations/nextValidation.ts` — optional pure selector for agent-executable pending validation work.
- `src/validations/discovery.ts` — scan pins/tasks/specs when present and produce reviewable validation candidates.
- `src/bridge/tools.ts` — validation Bridge tools.
- `src/webview/mission-control/*` — add Validations signal/closure strip and cards/list rows.
- `test/unit/validationStore.test.ts`, `test/unit/nextValidation.test.ts`, Bridge/UI tests as needed.
- `docs/specs/344-validation-queue-governance/*` — this spec.

## Risks & unknowns

- Risk: Validation becomes "Task 2.0". Keep entity language evidence/proof-oriented and avoid duplicating implementation workflow.
- Risk: Mission Control becomes crowded. Prototype whether Validations should be a tab, filter, or adjacent lane before implementation.
- Risk: Closed lifecycle fields can still feel restrictive. Keep only mechanical fields closed; keep semantic `type` and source refs open.
- Risk: Evidence semantics overlap worktree evidence. Reuse artifact/evidence reference patterns where possible instead of inventing another attachment system.
- Risk: Discovery can produce noisy candidates. Start with reviewable suggestions rather than silent auto-creation.

## Visual impact

Mission Control gains a validation surface and a pending-validation signal in the default project view. Visual risks: confusing Tasks vs Validations, too many tabs/filters, unclear human-vs-agent ownership, and unclear evidence-required closure. Capture screenshots of empty state, pending list, close-with-evidence flow, discovery candidates, and mixed task/validation project state.

## Sources consulted

- Pin `p-c429fb`.
- Fable review by ad-hoc agent `val344Fable` — endorsed name/standalone/open-type, required ingestion, status/outcome split, no `blocksRelease`, no owner/assignee duplication, pending badge.
- `docs/specs/325-task-queue-entity/plan.md` — open `kind`/`artifact_refs`, no SDD dependency.
- `docs/specs/335-mission-control-board/spec.md` and `notes.md` — Mission Control governance surface and human dogfood history.
- `src/tasks/types.ts`, `src/tasks/TaskStore.ts`, `src/tasks/nextTask.ts` — existing durable entity/store/selector pattern.
- `src/bridge/tools.ts` — Bridge tool shape and evidence/handoff patterns.
