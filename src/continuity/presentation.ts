import type { Pin } from "../pins/PinStore.js";
import type { Task } from "../tasks/types.js";
import type { ContinuityBrief } from "./ContinuityStore.js";
import { CONTINUITY_STALE_LAG } from "./classifier.js";

const CLOSED_TASK_STATUSES = new Set(["done", "dropped"]);
const REFERENCE_TOKEN = /t-[0-9a-f]{6}|\[\[[^\]\r\n]+\]\]/g;

export interface ContinuityProjectionInput {
  agent: string;
  brief: ContinuityBrief;
  currentActivitySeq?: number;
  tasks: Task[];
  pins: Pin[];
}

export function renderContinuity(input: ContinuityProjectionInput): string {
  const sourceSeq = input.brief.meta.source_activity_seq;
  const lag = typeof sourceSeq === "number" && input.currentActivitySeq !== undefined
    ? Math.max(0, input.currentActivitySeq - sourceSeq)
    : undefined;
  const freshness = lag !== undefined && lag > CONTINUITY_STALE_LAG
    ? `STALE: continuity brief is ${lag} activity records behind. Treat the narrative as historical and reconcile recent activity.\n\n`
    : "";
  return `${freshness}---\n${JSON.stringify(input.brief.meta)}\n---\n${input.brief.body}\n\n${renderDerivedOpenWork(input.agent, input.tasks, input.pins)}`;
}

export function renderDerivedOpenWork(agent: string, allTasks: Task[], allPins: Pin[]): string {
  const tasks = allTasks
    .filter((task) => task.assignee === agent && !CLOSED_TASK_STATUSES.has(task.status))
    .sort((a, b) => a.id.localeCompare(b.id));
  const pins = allPins
    .filter((pin) => pin.by === agent && !pin.done)
    .sort((a, b) => a.id.localeCompare(b.id));
  const taskLines = tasks.length > 0 ? tasks.map((task) => `- ${task.id}: ${task.title}`) : ["- (none)"];
  const pinLines = pins.length > 0 ? pins.map((pin) => `- ${pin.id}: ${pin.text}`) : ["- (none)"];
  return [
    "# Derived Open Work",
    "",
    "This section is calculated at read time. It is not stored in the continuity brief.",
    "",
    "## Open tasks assigned to you",
    ...taskLines,
    "",
    "## Open pins created by you",
    ...pinLines,
  ].join("\n");
}

export function removedContinuityReferences(previousBody: string, nextBody: string): string[] {
  const previous = uniqueReferences(previousBody);
  const next = new Set(uniqueReferences(nextBody));
  return previous.filter((token) => !next.has(token));
}

function uniqueReferences(body: string): string[] {
  return [...new Set(body.match(REFERENCE_TOKEN) ?? [])];
}
