import { z } from "zod";
import type { ManagedEntryInfo } from "../agents/AgentManager.js";
import {
  hasSharedCwdAttributionGap,
  type ActivityAttributionWorkspace,
} from "../activity/attributionGap.js";

const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const MAX_SHARE_TARGETS = 256;

/**
 * t-04052d — `declared` becomes `lifetime`. This row is TRANSPORT: the consumer (the Activity share
 * QuickPick) renders it as a description and nothing else, so no rule moved with it — the one rule
 * that lived on `declared`, handoff eligibility, stays in `handoffProjection` where it belongs rather
 * than being duplicated here.
 */
const target = z.object({
  name: z.string().regex(AGENT_NAME_RE),
  lifetime: z.enum(["saved", "temporary"]),
}).strict();

const context = z.object({
  schemaVersion: z.literal(1),
  agent: z.string().regex(AGENT_NAME_RE),
  sharedCwd: z.boolean(),
  attention: z.enum(["working", "idle", "needs-input", "throttled"]).nullable(),
  targets: z.object({
    total: z.number().int().nonnegative().max(1_000_000),
    truncated: z.boolean(),
    items: z.array(target).max(MAX_SHARE_TARGETS),
  }).strict(),
}).strict().superRefine((value, refinement) => {
  if (value.targets.items.some((row) => row.name === value.agent)) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: "Activity share targets include the source agent" });
  }
  if (new Set(value.targets.items.map((row) => row.name)).size !== value.targets.items.length) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate Activity share targets" });
  }
  if (value.targets.items.length > value.targets.total
    || value.targets.truncated !== (value.targets.total > value.targets.items.length)) {
    refinement.addIssue({ code: z.ZodIssueCode.custom, message: "Activity share target bounds contradict their total" });
  }
});

const view = z.object({ schemaVersion: z.literal(1), context }).strict();

export type ActivityContextProjectionV1 = z.infer<typeof context>;
export type ActivityContextViewV1 = z.infer<typeof view>;

export interface ActivityContextSource extends ActivityAttributionWorkspace {
  manager: ActivityAttributionWorkspace["manager"] & {
    list(): Promise<ManagedEntryInfo[]>;
  };
  attentionOf(agent: string): { state: "working" | "idle" | "needs-input" | "throttled" } | undefined;
}

export function parseActivityContextViewV1(value: unknown): ActivityContextViewV1 {
  return view.parse(value);
}

export function isActivityContextViewV1(value: unknown): value is ActivityContextViewV1 {
  return view.safeParse(value).success;
}

export async function projectActivityContext(
  source: ActivityContextSource,
  agent: string,
): Promise<ActivityContextProjectionV1> {
  if (!AGENT_NAME_RE.test(agent)) throw new Error(`invalid Activity agent '${agent}'`);
  const [rows, sharedCwd] = await Promise.all([
    source.manager.list(),
    hasSharedCwdAttributionGap(source, agent),
  ]);
  const targets = rows.filter((row) => row.name !== agent
    && row.kind === "agent"
    && row.running
    && !row.dead
    && !row.stopping);
  return context.parse({
    schemaVersion: 1,
    agent,
    sharedCwd,
    attention: source.attentionOf(agent)?.state ?? null,
    targets: {
      total: targets.length,
      truncated: targets.length > MAX_SHARE_TARGETS,
      items: targets.slice(0, MAX_SHARE_TARGETS).map((row) => ({
        name: row.name,
        lifetime: row.lifetime,
      })),
    },
  });
}
