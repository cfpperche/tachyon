import { z } from "zod";
import type { ScheduleDef } from "../config/loadConfig.js";
import { isStagedPayloadRefV1, type StagedPayloadRefV1 } from "./stagedPayload.js";

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/);
const text = (max: number, min = 0) => z.string().min(min).max(max);
const decision = z.enum(["approved", "denied"]);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const tmuxSession = z.string().min(1).max(256).regex(/^[^\0\r\n]+$/u);
const terminalAgent = z.string().min(1).max(128).regex(/^[^\0\r\n]+$/u);
const terminalTitle = z.string().min(1).max(256).regex(/^[^\0\r\n]+$/u);
const soulPayload = z.custom<StagedPayloadRefV1>(isStagedPayloadRefV1)
  .refine((value) => value.byteSize <= 64 * 1024, "Soul payload exceeds 64 KiB");

const spawnOptions = z.object({
  cmd: text(16_384, 1).optional(),
  cwd: text(4_096, 1).optional(),
  instructions: text(64 * 1024).optional(),
  parent: name.optional(),
  worktree: z.boolean().optional(),
}).strict();

const schedule = z.union([
  z.object({ every: text(64, 1), run: name, catchUp: z.boolean().optional() }).strict(),
  z.object({ at: text(64, 1), run: name, catchUp: z.boolean().optional() }).strict(),
  z.object({ every: text(64, 1), spawn: name, instructions: text(64 * 1024).optional(), catchUp: z.boolean().optional() }).strict(),
  z.object({ at: text(64, 1), spawn: name, instructions: text(64 * 1024).optional(), catchUp: z.boolean().optional() }).strict(),
]);

export const EXTENSION_QUERY_ACTIONS = [
  "agents.list", "attention.list", "pins.list", "commands.list", "runbooks.list", "schedules.list", "proposals.list",
  "doctor.report", "bridge.token", "companion.pair-code", "agent.inspect", "agent.fork-preview", "prompt.catalog", "worktree.review",
  "worktrees.list", "pipeline.inspect", "agent.wait", "soul.profile.status", "legacy-delivery.retirement-preview",
  "tmux.snapshot", "tmux.health", "tmux.capture",
] as const;

export const EXTENSION_COMMAND_ACTIONS = [
  "pipeline.seed", "agent.spawn", "pin.create", "command.run", "command.tick", "runbook.run", "proposal.create",
  "proposal.approve", "proposal.reject", "approval.resolve", "config.agent.add", "config.agent.clone",
  "config.agent.rename", "config.agent.delete", "config.agent.promote", "config.command.delete", "config.runbook.delete",
  "agent.fork", "worktree.remove", "worktree.delete-branch", "agent.verify", "agent.reanchor",
  "agent.inject-continuity", "agent.resume-all", "workspace.stop-all", "pipeline.start", "pipeline.approve",
  "pipeline.reject", "pipeline.cancel", "pipeline.rerun", "pipeline.dismiss", "pipeline.apply-input", "pipeline.delete",
  "bridge.restart", "bridge.stop", "config.health",
  "handoff.note", "prompt.inject", "runtime-ops.provider.configure",
  "soul.profile.create", "soul.profile.import", "soul.profile.replace", "soul.profile.adopt",
  "soul.profile.enable", "soul.profile.disable", "soul.profile.delete",
  "tmux.kill", "tmux.recover", "terminal.open", "terminal.close",
  "legacy-delivery.retirement-apply",
] as const;

const extensionQueryActionSchema = z.enum(EXTENSION_QUERY_ACTIONS);
const extensionCommandActionSchema = z.enum(EXTENSION_COMMAND_ACTIONS);

export const extensionQuerySchema = z.union([
  z.object({ action: z.literal("agents.list") }).strict(),
  z.object({ action: z.literal("attention.list") }).strict(),
  z.object({ action: z.literal("pins.list") }).strict(),
  z.object({ action: z.literal("commands.list") }).strict(),
  z.object({ action: z.literal("runbooks.list") }).strict(),
  z.object({ action: z.literal("schedules.list") }).strict(),
  z.object({ action: z.literal("proposals.list") }).strict(),
  z.object({ action: z.literal("doctor.report") }).strict(),
  z.object({ action: z.literal("legacy-delivery.retirement-preview") }).strict(),
  z.object({ action: z.literal("bridge.token") }).strict(),
  z.object({ action: z.literal("companion.pair-code") }).strict(),
  z.object({ action: z.literal("agent.inspect"), agent: name }).strict(),
  z.object({ action: z.literal("agent.fork-preview"), agent: name }).strict(),
  z.object({ action: z.literal("soul.profile.status"), agent: name }).strict(),
  z.object({ action: z.literal("tmux.snapshot") }).strict(),
  z.object({ action: z.literal("tmux.health") }).strict(),
  z.object({ action: z.literal("tmux.capture"), session: tmuxSession }).strict(),
  z.object({ action: z.literal("prompt.catalog") }).strict(),
  z.object({ action: z.literal("worktrees.list") }).strict(),
  z.object({ action: z.literal("worktree.review"), agent: name }).strict(),
  z.object({ action: z.literal("worktree.review"), runId: text(128, 1) }).strict(),
  z.object({ action: z.literal("pipeline.inspect"), name: name.optional(), runId: text(128, 1).optional() }).strict(),
  z.object({
    action: z.literal("agent.wait"),
    agent: name,
    until: z.enum(["idle", "needs-input", "dead"]),
    timeoutSec: z.number().int().positive().max(3_600),
  }).strict(),
]);

export type ExtensionQueryV1 = z.infer<typeof extensionQuerySchema>;
export type ExtensionQueryActionV1 = ExtensionQueryV1["action"];

export const tmuxPaneIdentitySchema = z.object({
  session: tmuxSession,
  window: z.number().int().nonnegative(),
  pane: z.number().int().nonnegative(),
  pid: z.number().int().nonnegative(),
  startCommand: text(16_384),
  createdAt: z.number().int().nonnegative().optional(),
}).strict();

export type TmuxPaneIdentityV1 = z.infer<typeof tmuxPaneIdentitySchema>;

export const extensionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pipeline.seed"), name }).strict(),
  z.object({ action: z.literal("agent.spawn"), agent: name, options: spawnOptions.optional() }).strict(),
  z.object({ action: z.literal("pin.create"), text: text(64 * 1024, 1), by: name, done: z.boolean() }).strict(),
  z.object({ action: z.literal("command.run"), name }).strict(),
  z.object({ action: z.literal("command.tick") }).strict(),
  z.object({ action: z.literal("runbook.run"), name }).strict(),
  z.object({ action: z.literal("proposal.create"), name, schedule, by: name, reason: text(2_000, 1).optional() }).strict(),
  z.object({ action: z.literal("proposal.approve"), id: text(64, 1) }).strict(),
  z.object({ action: z.literal("proposal.reject"), id: text(64, 1) }).strict(),
  z.object({ action: z.literal("approval.resolve"), id: text(128, 1), decision }).strict(),
  z.object({ action: z.literal("config.health") }).strict(),
  z.object({ action: z.literal("config.agent.add"), agent: name, cmd: text(16_384, 1), kind: z.enum(["agent", "terminal"]).optional() }).strict(),
  z.object({ action: z.literal("config.agent.clone"), agent: name, newName: name }).strict(),
  z.object({ action: z.literal("config.agent.rename"), agent: name, newName: name }).strict(),
  z.object({ action: z.literal("config.agent.delete"), agent: name, removeWorktree: z.boolean() }).strict(),
  z.object({ action: z.literal("config.agent.promote"), agent: name }).strict(),
  z.object({ action: z.literal("config.command.delete"), name }).strict(),
  z.object({ action: z.literal("config.runbook.delete"), name }).strict(),
  z.object({ action: z.literal("agent.fork"), agent: name }).strict(),
  z.object({ action: z.literal("worktree.remove"), agent: name }).strict(),
  z.object({ action: z.literal("worktree.delete-branch"), branch: text(512, 1) }).strict(),
  z.object({ action: z.literal("agent.verify"), agent: name }).strict(),
  z.object({ action: z.literal("agent.reanchor"), agent: name }).strict(),
  z.object({ action: z.literal("agent.inject-continuity"), agent: name }).strict(),
  z.object({ action: z.literal("agent.resume-all") }).strict(),
  z.object({ action: z.literal("workspace.stop-all") }).strict(),
  z.object({ action: z.literal("pipeline.start"), name, input: text(512 * 1024, 1).optional() }).strict(),
  z.object({ action: z.literal("pipeline.approve"), runId: text(128, 1), nodeId: text(128, 1) }).strict(),
  z.object({ action: z.literal("pipeline.reject"), runId: text(128, 1), nodeId: text(128, 1) }).strict(),
  z.object({ action: z.literal("pipeline.cancel"), runId: text(128, 1) }).strict(),
  z.object({ action: z.literal("pipeline.rerun"), runId: text(128, 1), nodeId: text(128, 1) }).strict(),
  z.object({ action: z.literal("pipeline.dismiss"), runId: text(128, 1) }).strict(),
  z.object({ action: z.literal("pipeline.apply-input"), runId: text(128, 1) }).strict(),
  z.object({ action: z.literal("pipeline.delete"), name }).strict(),
  z.object({ action: z.literal("bridge.restart") }).strict(),
  z.object({ action: z.literal("bridge.stop") }).strict(),
  z.object({
    action: z.literal("legacy-delivery.retirement-apply"),
    snapshotDigest: sha256,
    archiveId: text(128, 1),
  }).strict(),
  z.object({ action: z.literal("tmux.kill"), expected: tmuxPaneIdentitySchema }).strict(),
  z.object({ action: z.literal("tmux.recover") }).strict(),
  z.object({
    action: z.literal("terminal.open"),
    agent: terminalAgent,
    session: tmuxSession,
    title: terminalTitle.optional(),
  }).strict(),
  z.object({ action: z.literal("terminal.close"), agent: terminalAgent, session: tmuxSession }).strict(),
  z.object({ action: z.literal("soul.profile.create"), agent: name }).strict(),
  z.object({ action: z.literal("soul.profile.import"), agent: name, payload: soulPayload }).strict(),
  z.object({ action: z.literal("soul.profile.replace"), agent: name, payload: soulPayload, expectedDigest: sha256 }).strict(),
  z.object({ action: z.literal("soul.profile.adopt"), agent: name, expectedDigest: sha256 }).strict(),
  z.object({ action: z.literal("soul.profile.enable"), agent: name }).strict(),
  z.object({ action: z.literal("soul.profile.disable"), agent: name }).strict(),
  z.object({ action: z.literal("soul.profile.delete"), agent: name }).strict(),
  z.object({
    action: z.literal("runtime-ops.provider.configure"),
    provider: z.enum(["codex", "claude"]),
    enabled: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal("prompt.inject"),
    agent: name,
    templateId: name,
    expectedSha256: sha256,
    submit: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal("handoff.note"),
    summary: text(4_000, 1),
    evidence: z.array(text(4_096, 1)).max(20),
  }).strict(),
]);

export type ExtensionCommandV1 = z.infer<typeof extensionCommandSchema>;
export type ExtensionCommandActionV1 = ExtensionCommandV1["action"];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ExtensionOperationSuccessV1<Action extends string = string> {
  action: Action;
  value: JsonValue;
}

export function isExtensionQueryV1(value: unknown): value is ExtensionQueryV1 {
  return extensionQuerySchema.safeParse(value).success;
}

export function isExtensionQueryActionV1(value: unknown): value is ExtensionQueryActionV1 {
  return extensionQueryActionSchema.safeParse(value).success;
}

export function parseExtensionQueryV1(value: unknown): ExtensionQueryV1 {
  return extensionQuerySchema.parse(value);
}

export function isExtensionCommandV1(value: unknown): value is ExtensionCommandV1 {
  return extensionCommandSchema.safeParse(value).success;
}

export function isExtensionCommandActionV1(value: unknown): value is ExtensionCommandActionV1 {
  return extensionCommandActionSchema.safeParse(value).success;
}

export function parseExtensionCommandV1(value: unknown): ExtensionCommandV1 {
  return extensionCommandSchema.parse(value);
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 16 || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length <= 10_000 && value.every((entry) => isJsonValue(entry, depth + 1));
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 10_000
    && entries.every(([key, entry]) => key.length <= 256 && isJsonValue(entry, depth + 1));
}

export function scheduleDefFromExtensionCommand(
  command: Extract<ExtensionCommandV1, { action: "proposal.create" }>,
): ScheduleDef {
  return command.schedule as ScheduleDef;
}
