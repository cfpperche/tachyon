/**
 * Bridge MCP tools — public surface.
 *
 * t-3b47ad / SDD 489: tool registrations live in `src/bridge/tools/*` capability modules.
 * This file re-exports the shared types/helpers and orchestrates registration in the original order.
 */

export {
  type NotifyLevel,
  type NoticeDeliveryResult,
  type NoticeSourceMetadata,
  type BridgeDeps,
  type AttachEvidenceInput,
  contextRenewalRequestRefusal,
  validateProposedSchedule,
  CMD_WAIT_PREFIX,
  executeWait,
} from "./tools/shared.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeDeps } from "./tools/shared.js";
import { registerWorktreeTools } from "./tools/worktrees.js";
import { registerRuntimeSecurityTools } from "./tools/runtime-security.js";
import { registerHostActionTools } from "./tools/host-actions.js";
import { registerFleetTools } from "./tools/fleet.js";
import { registerUserBrowserTools } from "./tools/user-browser.js";
import { registerIdeBrowserTools } from "./tools/ide-browser.js";
import { registerConfigurationTools } from "./tools/configuration.js";
import { registerVerificationCoreTools } from "./tools/verification.js";
import { registerContinueTaskTool } from "./tools/tasks-continue.js";
import { registerCommunicationIoTools } from "./tools/communication-io.js";
import { registerPinTools } from "./tools/coordination-pins.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerValidationTools } from "./tools/verification-validations.js";
import { registerContinuityTools } from "./tools/coordination-continuity.js";
import { registerHandoffTools } from "./tools/coordination-handoff.js";
import { registerCommandTools } from "./tools/automation-commands.js";
import { registerWaitTools } from "./tools/communication-waits.js";
import { registerScheduleTools } from "./tools/automation-schedules.js";
import { registerApprovalTools } from "./tools/human-approvals.js";
import { registerNotifyTool } from "./tools/human-notify.js";
import { registerProbeTools } from "./tools/fleet-probes.js";

/**
 * Register every Bridge MCP tool. Domain registrars run in the historical registration order so the
 * catalog (names, descriptions, schemas, order) stays byte-identical for inventory comparison.
 */
export function registerTools(mcp: McpServer, deps: BridgeDeps): void {
  registerWorktreeTools(mcp, deps);
  registerRuntimeSecurityTools(mcp, deps);
  registerHostActionTools(mcp, deps);
  registerFleetTools(mcp, deps);
  registerUserBrowserTools(mcp, deps);
  registerIdeBrowserTools(mcp, deps);
  registerConfigurationTools(mcp, deps);
  registerVerificationCoreTools(mcp, deps);
  registerContinueTaskTool(mcp, deps);
  registerCommunicationIoTools(mcp, deps);
  registerPinTools(mcp, deps);
  registerTaskTools(mcp, deps);
  registerValidationTools(mcp, deps);
  registerContinuityTools(mcp, deps);
  registerHandoffTools(mcp, deps);
  registerCommandTools(mcp, deps);
  registerWaitTools(mcp, deps);
  registerScheduleTools(mcp, deps);
  registerApprovalTools(mcp, deps);
  registerNotifyTool(mcp, deps);
  registerProbeTools(mcp, deps);
}
