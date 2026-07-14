/**
 * spec 237 — structural item shapes the command handlers read. The webview sends these duck-typed
 * `{ws, agentName, …}` objects (see SidebarPrototype.runAction/runSection/runPipeline); the retired native
 * tree used to pass TreeItem instances carrying the same fields. Handlers must read ONLY these fields, so
 * the command layer is UI-agnostic — it works whether the caller is the webview, a test, or a future client.
 */
import type { PipelineRun } from "../pipeline/runState.js";
import type { WorkspacePresentationTarget } from "../shell/WorkspacePresentation.js";

export interface AgentItem { ws?: WorkspacePresentationTarget; agentName: string; contextValue?: string }
export interface PinItem { ws?: WorkspacePresentationTarget; pinId: string }
export interface CommandItem { ws?: WorkspacePresentationTarget; commandName: string }
export interface RunbookItem { ws?: WorkspacePresentationTarget; runbookName: string }
export interface ScheduleItem { ws?: WorkspacePresentationTarget; scheduleName: string }
export interface ProposalItem { ws?: WorkspacePresentationTarget; proposalId: string; label?: string }
export interface PipelineDefItem { ws?: WorkspacePresentationTarget; pipelineName: string; run?: PipelineRun }
export interface PipelineNodeItem { ws?: WorkspacePresentationTarget; runId?: string; nodeId?: string; run?: PipelineRun }
