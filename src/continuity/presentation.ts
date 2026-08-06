import type { Pin } from "../pins/PinStore.js";
import type { Task } from "../tasks/types.js";
import type { ContinuityBrief, ContinuityMeta } from "./ContinuityStore.js";
import { CONTINUITY_STALE_LAG } from "./classifier.js";

const CLOSED_TASK_STATUSES = new Set(["done", "dropped"]);
const REFERENCE_TOKEN = /t-[0-9a-f]{6}|\[\[[^\]\r\n]+\]\]/g;
export const DERIVED_OPEN_WORK_HEADING = "# Derived Open Work";
const DERIVED_OPEN_WORK_NOTICE = "This section is calculated at read time. It is not stored in the continuity brief.";
const NO_CONTINUITY_PLACEHOLDER = "(no continuity brief yet — create one with set_continuity once your goal/state are clear)";
const STALE_PREFIX = "STALE: continuity brief is ";
const STALE_SUFFIX = " activity records behind. Treat the narrative as historical and reconcile recent activity.";

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
  return composeContinuityRead({
    body: input.brief.body,
    meta: input.brief.meta,
    staleLag: lag !== undefined && lag > CONTINUITY_STALE_LAG ? lag : undefined,
    derivedOpenWork: renderDerivedOpenWork(input.agent, input.tasks, input.pins),
  });
}

export function renderMissingContinuity(agent: string, tasks: Task[], pins: Pin[]): string {
  return composeContinuityRead({
    body: NO_CONTINUITY_PLACEHOLDER,
    derivedOpenWork: renderDerivedOpenWork(agent, tasks, pins),
  });
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
    DERIVED_OPEN_WORK_HEADING,
    "",
    DERIVED_OPEN_WORK_NOTICE,
    "",
    "## Open tasks assigned to you",
    ...taskLines,
    "",
    "## Open pins created by you",
    ...pinLines,
  ].join("\n");
}

interface ContinuityReadParts {
  body: string;
  meta?: ContinuityMeta;
  staleLag?: number;
  derivedOpenWork: string;
}

function composeContinuityRead(parts: ContinuityReadParts): string {
  return `${renderReadPrefix(parts.meta, parts.staleLag)}${parts.body}\n\n${parts.derivedOpenWork}`;
}

export function decomposeContinuityRead(body: string, expectedMeta?: ContinuityMeta): string {
  const { body: withoutDerivedOpenWork, removed } = removeFinalDerivedOpenWork(body);
  if (!removed) return body;
  if (withoutDerivedOpenWork === NO_CONTINUITY_PLACEHOLDER) return "";
  if (!expectedMeta) return withoutDerivedOpenWork;

  const prefix = renderReadPrefix(expectedMeta, readStaleLag(withoutDerivedOpenWork));
  if (withoutDerivedOpenWork.startsWith(prefix)) return withoutDerivedOpenWork.slice(prefix.length);
  return withoutDerivedOpenWork;
}

function removeFinalDerivedOpenWork(body: string): { body: string; removed: boolean } {
  const marker = `${DERIVED_OPEN_WORK_HEADING}\n\n${DERIVED_OPEN_WORK_NOTICE}`;
  const headingIndex = body.lastIndexOf(DERIVED_OPEN_WORK_HEADING);
  if (headingIndex < 0 || !body.startsWith(marker, headingIndex)) return { body, removed: false };
  if (headingIndex > 0 && body[headingIndex - 1] !== "\n") return { body, removed: false };
  return { body: body.slice(0, headingIndex).trimEnd(), removed: true };
}

function renderMetadataEnvelope(meta: ContinuityMeta): string {
  return `---\n${JSON.stringify(meta)}\n---\n`;
}

function renderReadPrefix(meta?: ContinuityMeta, staleLag?: number): string {
  const freshness = staleLag === undefined ? "" : `${STALE_PREFIX}${staleLag}${STALE_SUFFIX}\n\n`;
  const metadata = meta === undefined ? "" : renderMetadataEnvelope(meta);
  return `${freshness}${metadata}`;
}

function readStaleLag(body: string): number | undefined {
  if (!body.startsWith(STALE_PREFIX)) return undefined;
  const suffixStart = body.indexOf(STALE_SUFFIX, STALE_PREFIX.length);
  if (suffixStart < 0) return undefined;
  const lag = body.slice(STALE_PREFIX.length, suffixStart);
  if (!/^\d+$/.test(lag)) return undefined;
  const end = suffixStart + STALE_SUFFIX.length;
  return body.startsWith("\n\n", end) ? Number(lag) : undefined;
}

export function removedContinuityReferences(previousBody: string, nextBody: string): string[] {
  const previous = uniqueReferences(previousBody);
  const next = new Set(uniqueReferences(nextBody));
  return previous.filter((token) => !next.has(token));
}

function uniqueReferences(body: string): string[] {
  return [...new Set(body.match(REFERENCE_TOKEN) ?? [])];
}
