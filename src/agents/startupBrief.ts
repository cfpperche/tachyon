import { PROJECT_GUIDANCE_MAX_FILES } from "../config/projectGuidance.js";
import type { AgentPromptManifest, PromptTaskLayer } from "./promptLayers.js";

/** Fixed protocol-only ceilings. Renderers accept no free-form strings, so these protect future
 * label growth from silently consuming the pane payload budget. */
export const MAX_STARTUP_BRIEF_SUMMARY_BYTES = 512;
export const MAX_STARTUP_BRIEF_INVENTORY_BYTES = 512;

export interface StartupBriefManifest {
  projectGuidanceSources: number;
  prompt: AgentPromptManifest;
}

function assertManifest(manifest: StartupBriefManifest): void {
  const count = manifest.projectGuidanceSources;
  if (!Number.isInteger(count) || count < 0 || count > PROJECT_GUIDANCE_MAX_FILES) {
    throw new Error(
      `startup brief project guidance source count must be an integer from 0 to ${PROJECT_GUIDANCE_MAX_FILES}`,
    );
  }
}

function present(value: boolean): "present" | "absent" {
  return value ? "present" : "absent";
}

function completionDisplay(completion: "deliverable" | "done_when"): "DELIVERABLE" | "DONE_WHEN" {
  return completion === "deliverable" ? "DELIVERABLE" : "DONE_WHEN";
}

function summaryTask(task: PromptTaskLayer): string {
  switch (task.kind) {
    case "absent": return "task contract (absent)";
    case "brief": return "task brief (present); task contract (absent)";
    case "contract": return `task contract (${completionDisplay(task.completion)})`;
  }
}

function inventoryTask(task: PromptTaskLayer): string {
  switch (task.kind) {
    case "absent": return "absent — awaiting assignment";
    case "brief": return "unstructured brief";
    case "contract": return `contract (${completionDisplay(task.completion)})`;
  }
}

/** t-e3aaae — ids first (they are what stops the agent inferring), collapsing to a count past the cap. */
function sessionRecordIds(record: NonNullable<AgentPromptManifest["sessionRecord"]>): string {
  if (record.assignedCount === 0) return "no assigned work";
  const shown = record.assignedTaskIds.join(", ");
  const hidden = record.assignedCount - record.assignedTaskIds.length;
  return hidden > 0 ? `${shown}, +${hidden} more` : shown;
}

function summarySessionRecord(record: AgentPromptManifest["sessionRecord"]): string[] {
  if (!record) return [];
  return [`work on record (${record.isolation}; ${sessionRecordIds(record)})`];
}

function inventorySessionRecord(record: AgentPromptManifest["sessionRecord"]): string[] {
  if (!record) return [];
  return [`Work on record: isolation ${record.isolation}; assigned ${sessionRecordIds(record)}`];
}

function assertBounded(rendered: string, maximum: number, label: string): string {
  const bytes = Buffer.byteLength(rendered, "utf8");
  if (bytes > maximum) throw new Error(`${label} is ${bytes} UTF-8 bytes, above its ${maximum}-byte protocol ceiling`);
  return rendered;
}

export function renderStartupBriefSummary(manifest: StartupBriefManifest): string {
  assertManifest(manifest);
  const prompt = manifest.prompt;
  const sourceLabel = manifest.projectGuidanceSources === 1 ? "source" : "sources";
  const contents = [
    `project guidance (${manifest.projectGuidanceSources} ${sourceLabel})`,
    `persistent instructions (${present(prompt.persistentInstructions)})`,
    ...(prompt.evolution ? [`Agent Evolution (v${prompt.evolution.version}; ${prompt.evolution.digest})`] : []),
    `Bridge guidance (${present(prompt.bridgeGuidance)})`,
    summaryTask(prompt.task),
    ...summarySessionRecord(prompt.sessionRecord),
  ].join("; ");
  // Only claim "awaiting assignment" when nothing states the work — a materialized board assignment
  // is an objective even though it reached the agent as a record rather than as a spawn contract.
  const objective = prompt.task.kind === "absent" && !(prompt.sessionRecord?.assignedCount)
    ? "\nTask objective: absent — awaiting assignment."
    : "";
  return assertBounded(`Contains: ${contents}.${objective}`, MAX_STARTUP_BRIEF_SUMMARY_BYTES, "startup brief summary");
}

export function renderStartupBriefInventory(manifest: StartupBriefManifest): string {
  assertManifest(manifest);
  const prompt = manifest.prompt;
  const sourceLabel = manifest.projectGuidanceSources === 1 ? "source" : "sources";
  const rendered = [
    "── STARTUP BRIEF CONTENTS ──",
    `Project guidance: ${manifest.projectGuidanceSources} ${sourceLabel}`,
    `Persistent instructions: ${present(prompt.persistentInstructions)}`,
    ...(prompt.evolution ? [`Agent Evolution: present (version ${prompt.evolution.version}; digest ${prompt.evolution.digest})`] : []),
    `Bridge guidance: ${present(prompt.bridgeGuidance)}`,
    `Task: ${inventoryTask(prompt.task)}`,
    ...inventorySessionRecord(prompt.sessionRecord),
    "── END STARTUP BRIEF CONTENTS ──",
  ].join("\n");
  return assertBounded(rendered, MAX_STARTUP_BRIEF_INVENTORY_BYTES, "startup brief inventory");
}
