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
  isInternalPlanStatus,
  type InternalPlanItem,
  type InternalPlanRead,
  type InternalPlanStatus,
} from "./internalPlan.js";

export const CODEX_INTERNAL_PLAN_NOTIFICATION = "turn/plan/updated" as const;

const STATUS_ALIASES: Record<string, InternalPlanStatus> = {
  pending: "pending",
  completed: "completed",
  "in-progress": "in-progress",
  in_progress: "in-progress",
  inProgress: "in-progress",
};

export function readCodexInternalPlan(input: {
  notifications: readonly unknown[];
}): InternalPlanRead {
  if (!input || !Array.isArray(input.notifications)) return { state: "mute" };
  let last: readonly InternalPlanItem[] | undefined;
  for (const raw of input.notifications) {
    const items = projectPlanUpdated(raw);
    if (items) last = items;
  }
  if (!last) return { state: "mute" };
  return { state: "snapshot", items: last };
}

function projectPlanUpdated(raw: unknown): readonly InternalPlanItem[] | undefined {
  if (!record(raw) || raw.method !== CODEX_INTERNAL_PLAN_NOTIFICATION) return undefined;
  if (!record(raw.params) || !Array.isArray(raw.params.plan)) return undefined;
  const items: InternalPlanItem[] = [];
  for (const entry of raw.params.plan) {
    const item = projectStep(entry);
    if (item) items.push(item);
  }
  return items;
}

function projectStep(raw: unknown): InternalPlanItem | undefined {
  if (!record(raw)) return undefined;
  const texto = typeof raw.step === "string" ? raw.step.trim() : "";
  if (!texto) return undefined;
  const status = mapStatus(raw.status);
  if (!status) return undefined;
  // Codex has no per-step id. Do not read `id`. Do not use the array index.
  return { texto, status };
}

function mapStatus(value: unknown): InternalPlanStatus | undefined {
  if (typeof value !== "string") return undefined;
  const mapped = STATUS_ALIASES[value];
  if (mapped) return mapped;
  return isInternalPlanStatus(value) ? value : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
