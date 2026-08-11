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
/**
 * SDD 501 — a managed-worktree ROW, sent by the Worktrees dashboard's land block.
 *
 * It carries `workspaceHash` rather than a `ws` target for the reason that panel is a dashboard: its
 * project is the panel's own immutable one (SDD 485 D6), so the host names it by hash instead of
 * forwarding a target a webview message could have shaped. Same duck-typing rule as the rest of this
 * file — a handler reads these fields and nothing else.
 */
export interface WorktreeRowItem {
  ws?: WorkspacePresentationTarget;
  workspaceHash?: string;
  worktreeId: string;
  /** Review (t-ea5425) or PR form (t-f3ded3) selection chrome — command decides which shapes it accepts. */
  select?: WorktreeReviewSelection | WorktreePrSelection;
}

/**
 * t-ea5425 — which chrome picks the changed file, said by the CALLER.
 *
 * `"list"` asks for the candidates and opens nothing (a caller with its own picker — the Worktrees
 * webview draws the product QuickPicker); `{ file }` says that picker already chose. Omitting it keeps
 * VS Code's quick pick, which is still the right product for a tree item with no surface of its own.
 * Only the SELECTION varies: every door opens the diff through the one flow in `extension.ts`.
 */
export type WorktreeReviewSelection = "list" | { file: string };

/**
 * t-f3ded3 — which chrome collects the PR title and confirms, said by the CALLER.
 *
 * `"draft"` probes readiness at click, composes title/body/meta, and returns them — opens nothing.
 * The Worktrees webview draws the product ConfirmForm. `{ title }` says that form already confirmed;
 * the host creates the PR with the edited title. Omitting it keeps the native InputBox + modal, which
 * is still the right product for a sidebar tree item with no surface of its own.
 * Only the SELECTION chrome varies: readiness probe and PR create stay on the host.
 */
export type WorktreePrSelection = "draft" | { title: string };

/** t-f3ded3 — draft payload a webview caller gets back from `"draft"`. */
export interface WorktreePrDraft {
  subject: string;
  branch: string;
  title: string;
  body: string;
  /** Persisted base branch, or null when gh will pick its default. */
  base: string | null;
  dirty: boolean;
}
