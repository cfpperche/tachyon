/**
 * spec 237 — structural item shapes the command handlers read. The webview sends these duck-typed
 * `{ws, agentName, …}` objects (see SidebarPrototype.runAction/runSection/runPipeline); the retired native
 * tree used to pass TreeItem instances carrying the same fields. Handlers must read ONLY these fields, so
 * the command layer is UI-agnostic — it works whether the caller is the webview, a test, or a future client.
 */
import type { Workspace } from "../workspace/Workspace.js";
import type { PipelineRun } from "../pipeline/runState.js";

export interface AgentItem { ws?: Workspace; agentName: string; contextValue?: string }
export interface PinItem { ws?: Workspace; pinId: string }
export interface CommandItem { ws?: Workspace; commandName: string }
export interface RunbookItem { ws?: Workspace; runbookName: string }
export interface ScheduleItem { ws?: Workspace; scheduleName: string }
export interface ProposalItem { ws?: Workspace; proposalId: string; label?: string }
export interface PipelineDefItem { ws?: Workspace; pipelineName: string; run?: PipelineRun }
export interface PipelineNodeItem { ws?: Workspace; runId?: string; nodeId?: string; run?: PipelineRun }
