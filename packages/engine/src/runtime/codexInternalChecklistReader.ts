/**
 * t-1ee107 — project a Codex `turn/plan/updated` notification onto the
 * canonical internal-plan type.
 *
 * Channel: app-server JSON-RPC `turn/plan/updated` (schema 0.147.0
 * `v2/TurnPlanUpdatedNotification.json`). `plan[]` is the complete ordered
 * list of `{step, status}`. The last such notification is the plan.
 *
 * Codex steps are ordered and have no per-step identity. `id` and `blockedBy`
 * are omitted — never invented from index or order.
 *
 * Not a plan (measured 2026-08-16, docs/research/poc-plano-interno-codex.md):
 * - `item/plan/delta` is EXPERIMENTAL; it did not fire even with
 *   `experimentalApi: true`. Concatenated deltas are not a plan.
 * - `turn.items` on `turn/completed` is a summary. The induce turn that
 *   emitted a plan still had no plan item there.
 *
 * Absence is mute (no `turn/plan/updated`). `plan: []` was never observed.
 * `turn/plan/cleared` and `turn/plan/absent` are not in schema 0.147.0.
 */
import {
  isInternalChecklistStatus,
  type InternalChecklistItem,
  type InternalChecklistRead,
  type InternalChecklistStatus,
} from "./internalChecklist.js";

export const CODEX_INTERNAL_CHECKLIST_NOTIFICATION = "turn/plan/updated" as const;

const STATUS_ALIASES: Record<string, InternalChecklistStatus> = {
  pending: "pending",
  completed: "completed",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  inProgress: "in-progress",
};

export function readCodexInternalChecklist(input: {
  notifications: readonly unknown[];
}): InternalChecklistRead {
  if (!input || !Array.isArray(input.notifications)) return { state: "mute" };
  let last: readonly InternalChecklistItem[] | undefined;
  for (const raw of input.notifications) {
    const items = projectChecklistUpdated(raw);
    if (items) last = items;
  }
  if (!last) return { state: "mute" };
  return { state: "snapshot", items: last };
}

function projectChecklistUpdated(raw: unknown): readonly InternalChecklistItem[] | undefined {
  if (!record(raw) || raw.method !== CODEX_INTERNAL_CHECKLIST_NOTIFICATION) return undefined;
  if (!record(raw.params) || !Array.isArray(raw.params.plan)) return undefined;
  const items: InternalChecklistItem[] = [];
  for (const entry of raw.params.plan) {
    const item = projectStep(entry);
    if (item) items.push(item);
  }
  return items;
}

function projectStep(raw: unknown): InternalChecklistItem | undefined {
  if (!record(raw)) return undefined;
  const text = typeof raw.step === "string" ? raw.step.trim() : "";
  if (!text) return undefined;
  const status = mapStatus(raw.status);
  if (!status) return undefined;
  // Codex has no per-step id. Do not read `id`. Do not use the array index.
  return { text, status };
}

function mapStatus(value: unknown): InternalChecklistStatus | undefined {
  if (typeof value !== "string") return undefined;
  const mapped = STATUS_ALIASES[value];
  if (mapped) return mapped;
  return isInternalChecklistStatus(value) ? value : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
