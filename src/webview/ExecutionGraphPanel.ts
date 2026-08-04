import * as vscode from "vscode";
import type { SealedExecutionEvent } from "../executionGraph/eventSchema.js";
import { indexExecutionDetail, projectExecutions } from "../executionGraph/executionProjection.js";
import { engineCurrencyNote, type EngineCurrency } from "../engine-service/engineCurrency.js";
import { buildExecutionGraphVm, type ExecutionGraphVm } from "../cockpit/executionGraphVm.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { POLL, READY, executionGraphModelMessage, type ExecutionGraphStrings } from "./execution-graph/messages.js";

export const EXECUTION_GRAPH_VIEW_TYPE = "tachyonExecutionGraph";
type RefreshKind = "execution-graph";

export interface ExecutionGraphDeps {
  read(wsHash: string | undefined): { events: SealedExecutionEvent[]; available: boolean; currency?: EngineCurrency };
}

/**
 * SDD 485 D9 — dashboard cardinality is dictated by `buildExecutionGraphSectionVm(deps, wsHash)`:
 * its source accepts one project. The viewType is new because Execution was born inside Control.
 * Selection, filters and derived detail live in the app root, so each panel owns an independent view.
 * The ck-eg stylesheet moves with its sole consumer; no shared Control utility is consumed.
 */
export class ExecutionGraphPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  constructor(extensionUri: vscode.Uri, private readonly deps: ExecutionGraphDeps,
    app: WebviewAppEntry = webviewApp("execution-graph"), scope?: ControlWorkspaceScope) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }
  open(project: string): void { this.manager.open({ project }); }
  get openKeys(): string[] { return this.manager.openKeys; }
  openInCurrentScope(): boolean { return this.manager.openInCurrentScope(); }
  refresh(): void { this.manager.refresh("execution-graph"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "design-system.css", "execution-graph.css"],
      title: () => vscode.l10n.t("Execution"),
      bootstrapGlobals: () => ({ __TACHYON_STRINGS__: executionGraphStrings() }),
      refreshKindFor: executionGraphRefreshKind,
      bind: (session) => {
        const send = () => session.post(executionGraphModelMessage(buildExecutionGraphSectionVm(this.deps, session.target.project)));
        return { replay: send, resync: send, onMessage: () => undefined };
      },
    };
  }
}

export function buildExecutionGraphSectionVm(deps: ExecutionGraphDeps, wsHash: string | undefined): ExecutionGraphVm {
  try {
    const { events, available, currency } = deps.read(wsHash);
    if (!available) {
      const statusNote = currency ? engineCurrencyNote(currency) : undefined;
      return buildExecutionGraphVm({ projection: { executions: [], edges: [], agentIds: [] }, status: "no-telemetry", ...(statusNote ? { statusNote } : {}) });
    }
    const detail = indexExecutionDetail(events);
    return buildExecutionGraphVm({ projection: projectExecutions(events), detailFor: (id) => detail.get(id) });
  } catch (error) {
    return buildExecutionGraphVm({ projection: { executions: [], edges: [], agentIds: [] }, status: "error", errorDetail: error instanceof Error ? error.message : String(error) });
  }
}

export function executionGraphRefreshKind(message: unknown): RefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "execution-graph" : undefined;
}

function executionGraphStrings(): ExecutionGraphStrings {
  const t = vscode.l10n.t;
  return {
    executionGraphTitle: t("Execution graph"), egCanvasLabel: t("Execution graph diagram"),
    egTableLabel: t("Execution graph, as a table"), egLoading: t("Loading the execution ledger…"),
    egEmpty: t("No executions match these filters."), egNoTelemetry: t("This workspace is not recording execution telemetry yet."),
    egError: t("The execution ledger could not be read."), egGroupedNote: t("Some lanes are grouped to stay readable; totals below are complete."),
    egFilterTurn: t("Turn"), egFilterState: t("State"), egFilterKind: t("Type"), egFilterAgent: t("Agent"), egFilterAll: t("All"),
    egColKind: t("Type"), egColState: t("State"), egColAgents: t("Agents"), egColAttribution: t("Attribution"),
    egColStarted: t("Started"), egColDuration: t("Duration"), egColExit: t("Exit"), egDetailTitle: t("Execution detail"),
    egDetailNone: t("Select an execution to see its detail."), egDetailDuration: t("Duration"), egDetailExit: t("Exit code"),
    egDetailCwd: t("Working directory"), egDetailWorktree: t("Worktree"), egDetailTool: t("Started by tool"),
    egDetailIdentity: t("Identity proof"), egDetailTurn: t("Turn"), egDetailToolCall: t("Tool call"),
    egAttrProven: t("proven"), egAttrShared: t("shared"), egAttrUnproven: t("unproven"),
  };
}
