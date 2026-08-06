import { z } from "zod";
import { CARD_COMPONENT_IDS, CARD_TEMPLATE_VERSION, type CardComponentId } from "../sidebar/cardTemplate.js";
import type { FleetVM, HandoffVM, PinVM, ProposalVM, WorkspaceRef } from "../sidebar/types.js";
import { fitSidebarWireText, SIDEBAR_FOCUS_FULL_MAX, SIDEBAR_PIN_TEXT_MAX } from "../sidebar/wireText.js";
import { AGENT_NAME_PATTERN } from "../config/nameValidation.js";
import {
  buildSidebarFleet,
  type SidebarFleetServiceOptions,
  type SidebarFleetSource,
} from "../sidebar/sidebarFleetService.js";

export const SIDEBAR_ROW_LIMIT = 1_000;

export type SidebarFleetV1 = FleetVM & {
  folder: WorkspaceRef;
  handoff: HandoffVM;
  proposals: ProposalVM[];
  pins: Array<PinVM & { id: string }>;
  /** Present after projectSidebarView; optional on hand-built test fixtures. */
  notices?: NonNullable<FleetVM["notices"]>;
};

export interface SidebarViewV1 {
  schemaVersion: 1;
  fleet: SidebarFleetV1;
}

const text = (max: number, min = 0) => z.string().min(min).max(max);
const displayText = (max: number, min = 0, marker = "…") => z.string().min(min)
  .transform((value) => fitSidebarWireText(value, max, marker))
  .pipe(z.string().min(min).max(max));
/** SDD 479 — the wire may only carry ids the catalog actually implements. */
const cardComponentId = z.enum(CARD_COMPONENT_IDS as unknown as [CardComponentId, ...CardComponentId[]]);
/** One complete card template. Shared by the project's base and by every resolved runtime override. */
const cardTemplate = z.object({
  version: z.literal(CARD_TEMPLATE_VERSION),
  header: z.array(cardComponentId).max(CARD_COMPONENT_IDS.length),
  meta: z.array(cardComponentId).max(CARD_COMPONENT_IDS.length),
  footer: z.array(cardComponentId).max(CARD_COMPONENT_IDS.length),
}).strict();
// Agent/config names are identities, not display prose: truncating them could redirect an action to
// a different entity. The authoring doors already require this alphabet; the reader therefore keeps
// the full identity instead of imposing a second, contradictory size rule (t-a11ac5).
const name = z.string().min(1).regex(AGENT_NAME_PATTERN);
const count = z.number().int().nonnegative().max(1_000_000);
const agentStatus = z.enum(["running", "needs", "throttled", "done", "idle", "stopping", "stop-failed", "stopped", "crashed"]);
const evidence = z.object({
  total: count,
  stale: count,
  warn: count,
  error: count,
}).strict().superRefine((value, context) => {
  if (value.stale > value.total || value.warn > value.total || value.error > value.total) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar evidence counts contradict their total" });
  }
});

const externalToolItem = z.object({
  id: text(256, 1),
  kind: text(64, 1),
  tool: text(128, 1),
  title: displayText(512, 1).optional(),
  pid: z.number().int().positive().max(2_147_483_647).optional(),
  windowId: text(256, 1).optional(),
  startedAt: text(64, 1),
  source: text(64, 1),
  confidence: text(32, 1),
}).strict();

const externalTools = z.object({
  active: count,
  kinds: z.array(z.enum(["browser", "desktop", "screen", "host-action", "gui"])).max(5),
  strongestConfidence: z.enum(["strong", "medium", "weak"]),
  items: z.array(externalToolItem).max(100),
}).strict().superRefine((value, context) => {
  if (value.items.length > value.active || new Set(value.kinds).size !== value.kinds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar external-tool summary is contradictory" });
  }
});

const persistenceHooks = z.object({
  state: z.enum(["active", "skipped", "failed", "unknown"]),
  reason: displayText(1_000, 1).optional(),
  path: displayText(4_096, 1).optional(),
  updatedAt: text(64, 1).optional(),
}).strict();

const agent = z.object({
  name,
  model: displayText(256, 1).optional(),
  modelSource: z.enum(["observed", "declared", "profile"]).optional(),
  modelObservedAt: text(64, 1).optional(),
  modelStale: z.boolean().optional(),
  modelDivergence: z.boolean().optional(),
  /** SDD 479 phase 3 — the runtime this row runs on; selects a per-runtime card template. */
  runtime: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
  status: agentStatus,
  attention: displayText(256, 1).optional(),
  parent: name.optional(),
  delegator: name.optional(),
  declaredOwner: name.optional(),
  sub: displayText(2_000, 1).optional(),
  worktree: displayText(512, 1).optional(),
  liveBranch: displayText(512, 1).optional(),
  branchDrift: z.boolean().optional(),
  worktreePath: displayText(4_096, 1).optional(),
  resources: z.object({
    cpuPct: z.number().finite().min(0).max(999).optional(),
    memMb: count,
  }).strict().optional(),
  verify: z.enum(["pass", "fail", "stale"]).optional(),
  harness: z.boolean().optional(),
  resumable: z.boolean().optional(),
  freshStart: z.boolean().optional(),
  exited: z.boolean().optional(),
  pane: z.boolean().optional(),
  forked: z.boolean().optional(),
  continuity: z.enum(["fresh", "stale", "missing"]).optional(),
  focus: z.object({
    text: displayText(128, 1),
    source: z.enum(["task", "brief", "continuity"]),
    taskId: z.string().regex(/^t-[0-9a-f]{6}$/).optional(),
    full: displayText(SIDEBAR_FOCUS_FULL_MAX, 1, "… — open the agent for the full brief"),
  }).strict().optional(),
  persistenceHooks: persistenceHooks.optional(),
  evidence: evidence.optional(),
  externalTools: externalTools.optional(),
  awaitingHuman: z.object({ reason: displayText(2_000) }).strict().optional(),
  configInvalid: z.boolean().optional(),
  // t-0ad300 — the refusal reason for a declared agent this load would not project. Bounded like
  // every other free text on the wire; the full reason also lives in the config banner.
  refused: displayText(500).optional(),
  // SDD 478 M5 — the managed-entry arm, required because every row has one. This schema is
  // `.strict()`, so it is the wire contract: a row carrying an arm it does not declare is REJECTED,
  // not silently trimmed. That is why removing `ai` had to land here in the same change.
  kind: z.enum(["agent", "terminal"]),
  adhoc: z.boolean().optional(),
  verifiable: z.boolean().optional(),
  forkable: z.boolean().optional(),
  canDismiss: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if ((value.model === undefined) !== (value.modelSource === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar model and provenance must appear together" });
  }
  if (value.modelObservedAt !== undefined && value.modelSource !== "observed") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar observed timestamp contradicts model provenance" });
  }
  if (value.freshStart && !value.resumable) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar fresh-start flag requires resumable state" });
  }
  if (value.branchDrift && (value.worktree === undefined || value.liveBranch === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar branch drift requires configured and live branches" });
  }
});

const pipelineNode = z.object({
  id: name,
  status: agentStatus,
  label: displayText(128, 1),
  reason: displayText(2_000, 1).optional(),
  agentName: name.optional(),
}).strict();

const fleet = z.object({
  folder: z.object({ hash: text(128, 1), name: displayText(256, 1) }).strict(),
  bridge: z.object({ port: text(16, 1), connected: z.boolean() }).strict(),
  agents: z.array(agent).max(SIDEBAR_ROW_LIMIT),
  terminals: z.array(agent).max(SIDEBAR_ROW_LIMIT),
  pipelines: z.array(z.object({
    name,
    status: z.enum(["idle", "running", "paused", "failed"]),
    nodes: z.array(pipelineNode).max(SIDEBAR_ROW_LIMIT),
  }).strict()).max(SIDEBAR_ROW_LIMIT),
  schedules: z.array(z.object({ name, when: displayText(512, 1), next: displayText(256, 1), paused: z.boolean() }).strict()).max(SIDEBAR_ROW_LIMIT),
  commands: z.array(z.object({
    name,
    cmd: displayText(8_192),
    state: z.enum(["running", "passed", "failed", "idle"]),
    detail: displayText(256, 1),
  }).strict()).max(SIDEBAR_ROW_LIMIT),
  runbooks: z.array(z.object({
    name,
    running: z.boolean(),
    failed: z.boolean(),
    detail: displayText(256, 1),
    steps: z.array(z.object({
      n: z.number().int().positive().max(SIDEBAR_ROW_LIMIT),
      label: displayText(8_192, 1),
      state: z.enum(["running", "passed", "failed", "skipped"]),
      detail: displayText(256, 1).optional(),
    }).strict()).max(SIDEBAR_ROW_LIMIT),
  }).strict()).max(SIDEBAR_ROW_LIMIT),
  pins: z.array(z.object({
    id: z.string().regex(/^p-[0-9a-f]{6}$/),
    text: displayText(SIDEBAR_PIN_TEXT_MAX, 1, "… — open the pin for full detail"),
    done: z.boolean(),
    by: displayText(128, 1).optional(),
    tags: z.array(z.string().min(1)),
    detail: z.boolean().optional(),
    attachmentCount: count.optional(),
  }).strict()).max(SIDEBAR_ROW_LIMIT),
  notices: z.array(z.object({
    id: z.string().uuid(),
    message: displayText(512, 1),
    level: z.enum(["info", "warn", "error"]),
    at: text(64, 1),
    collapsedCount: z.number().int().positive().max(10_000),
    actions: z.array(z.object({
      id: z.string().uuid(),
      label: displayText(128, 1),
    }).strict()).max(12),
    read: z.boolean(),
    actionsLive: z.boolean(),
  }).strict()).max(100).default([]),
  proposals: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{12}$/),
    name,
    by: displayText(128, 1).optional(),
    reason: displayText(2_000, 1).optional(),
    when: displayText(512, 1).optional(),
  }).strict()).max(SIDEBAR_ROW_LIMIT),
  handoff: z.object({
    exists: z.boolean(),
    staleness: z.enum(["fresh", "needs_distill", "possibly_stale", "old"]),
    pendingCount: count,
  }).strict(),
  configError: z.object({
    file: displayText(256, 1),
    path: displayText(4_096, 1),
    errors: z.array(displayText(2_000, 1)).min(1).max(100),
    summary: displayText(2_000, 1),
  }).strict().optional(),
  // t-aa2780 — the engine's own report that its daemon log ring holds an error line. Declared here or
  // this STRICT object rejects the whole fleet (SDD 478 M5). OPTIONAL on purpose: a projection built
  // outside the engine process cannot read that ring, and "unset" has to stay distinguishable from
  // "read it, no errors" — the sidebar draws no dot for either, but only one of them is a measurement.
  engineLogHasError: z.boolean().optional(),
  // SDD 479 — declared here, or this STRICT object drops the field and the whole fleet with it (the
  // failure SDD 478 M5 hit: an undeclared field made ROWS vanish, not just that field). The ids are
  // re-checked against the live catalog, so a wire value the product cannot render never reaches the
  // renderer even if something upstream stopped validating.
  cardTemplate: z.object({
    base: cardTemplate,
    // SDD 479 phase 3 — overrides arrive already RESOLVED to complete templates, so the wire carries
    // no inheritance for the renderer to re-interpret. Keys are runtime names, bounded like any other
    // wire string; one the product does not run simply never matches a row.
    runtimes: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), cardTemplate).optional(),
  }).strict().optional(),
  cardTemplateRefusal: z.object({
    file: displayText(256, 1),
    errors: z.array(displayText(2_000, 1)).min(1).max(100),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  const agentNames = [...value.agents, ...value.terminals].map((row) => row.name);
  if (new Set(agentNames).size !== agentNames.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar managed-entry names must be unique" });
  }
  for (const rows of [value.pipelines, value.schedules, value.commands, value.runbooks]) {
    if (new Set(rows.map((row) => row.name)).size !== rows.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar section names must be unique" });
    }
  }
  if (new Set(value.pins.map((row) => row.id)).size !== value.pins.length
    || new Set(value.proposals.map((row) => row.id)).size !== value.proposals.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "sidebar entity ids must be unique" });
  }
});

const view = z.object({ schemaVersion: z.literal(1), fleet }).strict();

export async function projectSidebarView(
  source: SidebarFleetSource,
  options: SidebarFleetServiceOptions = {},
): Promise<SidebarViewV1> {
  return parseSidebarViewV1({ schemaVersion: 1, fleet: await buildSidebarFleet(source, options) });
}

export function parseSidebarViewV1(value: unknown): SidebarViewV1 {
  return view.parse(value) as SidebarViewV1;
}

export function isSidebarViewV1(value: unknown): value is SidebarViewV1 {
  return view.safeParse(value).success;
}
