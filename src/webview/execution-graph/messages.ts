import type { ExecutionGraphVm } from "../../cockpit/executionGraphVm.js";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready.js";

export { READY, readyMessage, type ReadyMessage };
export const POLL = "pollExecutionGraph" as const;
export const MODEL = "executionGraphModel" as const;
export interface ExecutionGraphStrings {
  executionGraphTitle: string;
  executionGraphHint: string;
  egCanvasLabel: string; egTableLabel: string; egLoading: string; egEmpty: string;
  egNoTelemetry: string; egError: string; egGroupedNote: string; egFilterTurn: string;
  egFilterState: string; egFilterKind: string; egFilterAgent: string; egFilterAll: string;
  egColKind: string; egColState: string; egColAgents: string; egColAttribution: string;
  egColStarted: string; egColDuration: string; egColExit: string; egDetailTitle: string;
  egDetailNone: string; egDetailDuration: string; egDetailExit: string; egDetailCwd: string;
  egDetailWorktree: string; egDetailTool: string; egDetailIdentity: string; egDetailTurn: string;
  egDetailToolCall: string; egAttrProven: string; egAttrShared: string; egAttrUnproven: string;
}
export type ExecutionGraphAction = ReadyMessage | { type: typeof POLL };
export const pollExecutionGraphAction = (): ExecutionGraphAction => ({ type: POLL });
export const executionGraphModelMessage = (vm: ExecutionGraphVm) => ({ type: MODEL, vm } as const);
