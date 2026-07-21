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
    case "absent": return "absent";
    case "brief": return "unstructured brief";
    case "contract": return `contract (${completionDisplay(task.completion)})`;
  }
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
    `soul (${present(prompt.soul)})`,
    `role (${present(prompt.role)})`,
    `persistent instructions (${present(prompt.persistentInstructions)})`,
    ...(prompt.evolution ? [`Agent Evolution (v${prompt.evolution.version}; ${prompt.evolution.digest})`] : []),
    `Bridge guidance (${present(prompt.bridgeGuidance)})`,
    summaryTask(prompt.task),
  ].join("; ");
  const objective = prompt.task.kind === "absent"
    ? "\nTask objective: absent — this launch supplied no task brief."
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
    `Soul: ${present(prompt.soul)}`,
    `Role: ${present(prompt.role)}`,
    `Persistent instructions: ${present(prompt.persistentInstructions)}`,
    ...(prompt.evolution ? [`Agent Evolution: present (version ${prompt.evolution.version}; digest ${prompt.evolution.digest})`] : []),
    `Bridge guidance: ${present(prompt.bridgeGuidance)}`,
    `Task: ${inventoryTask(prompt.task)}`,
    "── END STARTUP BRIEF CONTENTS ──",
  ].join("\n");
  return assertBounded(rendered, MAX_STARTUP_BRIEF_INVENTORY_BYTES, "startup brief inventory");
}
