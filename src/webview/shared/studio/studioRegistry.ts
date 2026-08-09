/**
 * t-610705 (SDD 410 Phase D) — the ONE registry keyed by StudioId (studios-routes-design.md): every
 * studio's adapter construction, legacy-serializer viewType, and (when it has one) domain-message
 * handler lives here — nowhere else declares a parallel per-studio list. `satisfies
 * Record<StudioId, ...>` (not a type annotation) so adding a StudioId without a matching entry is a
 * compile error, not a silent `undefined` at a Map lookup (round-2 F14's rule).
 *
 * D0 shipped "command". D1a (this PR) adds terminal/runbook/schedule — D1b (Agent Studio, split out
 * for its much larger evolution/profile domain-message surface), D2 (task), D3 (pin) each add
 * their entry here — this file, `studioIds.ts`, and every exhaustive switch in `route.ts` are the
 * whole checklist; the compiler enforces the rest.
 */
import * as vscode from "vscode";
import type { StudioId } from "./studioIds.js";
import type { StudioHostAdapter } from "./adapter.js";
import type { WorkspaceStudioTarget, WorkspaceAgentStudioTarget } from "../../../shell/WorkspacePresentation.js";
import type { WorkspaceTaskStudioTarget } from "../../../shell/TaskStudioTarget.js";
import type { WorkspacePinStudioTarget } from "../../../shell/PinStudioTarget.js";
import { CommandStudioAdapter } from "../../CommandStudioAdapter.js";
import { TerminalStudioAdapter } from "../../TerminalStudioAdapter.js";
import { RunbookStudioAdapter } from "../../RunbookStudioAdapter.js";
import { ScheduleStudioAdapter } from "../../ScheduleStudioAdapter.js";
import { AgentStudioAdapter } from "../../AgentStudioAdapter.js";
import { TaskStudioAdapter } from "../../TaskStudioAdapter.js";
import { PinStudioAdapter } from "../../PinStudioAdapter.js";
import { createAgentEvolutionLabels, createAgentProfileLabels } from "../../agent-studio-shell/domain.js";
import { handleAgentStudioDomainMessage } from "../../../cockpit/agentStudioDomain.js";
import { handleTaskStudioDomainMessage } from "../../../cockpit/taskStudioDomain.js";
import { handlePinStudioDomainMessage } from "../../pin-studio/pinStudioDomain.js";
import { envelope } from "../../shared/studio/protocol.js";

type Adapter = StudioHostAdapter<unknown, unknown, unknown, unknown>;

/** t-9dadad — the task/pin studio surfaces live as nested sub-targets on the workspace handle
 *  (`handle.taskStudio` / `handle.pinStudio`), NOT flat on the handle like agent's. Resolves the
 *  nested target and fails LOUDLY (a thrown, host-visible error the studio error envelope carries)
 *  if a future handle shape drops it — never a silent `undefined` method call. */
interface NestedStudioTargets {
  taskStudio: WorkspaceTaskStudioTarget;
  pinStudio: WorkspacePinStudioTarget;
}
function nestedTarget<K extends keyof NestedStudioTargets>(ws: WorkspaceStudioTarget, key: K): NestedStudioTargets[K] {
  const nested = (ws as Partial<NestedStudioTargets>)[key];
  if (!nested) throw new Error(`workspace handle for '${ws.folderName}' is missing its nested '${key}' studio target`);
  return nested;
}

export interface StudioDomainContext {
  post: (message: unknown) => void;
  /** t-610705 (Phase D, D1b) — the current binding's own entity id (undefined for studio-new).
   *  Domain handlers use it to reject messages whose entity/agent field does not match the bound
   *  subject (see agentStudioDomain.ts and other handleDomainMessage call sites). */
  entityId: string | undefined;
}

export interface StudioRegistryEntry {
  /** the legacy standalone panel's viewType — the retirement serializer redirects it into Control. */
  legacyViewType: string;
  makeAdapter: (ws: WorkspaceStudioTarget) => Adapter;
  /** studio-specific messages outside the 9 core protocol types (protocol.ts's CORE_MESSAGE_TYPES);
   *  absent for a studio with none. Mirrors StudioPanelManagerBase's `onDomainMessage` constructor
   *  hook — same "one declared extension point, never a bypass" budget. */
  handleDomainMessage?: (ws: WorkspaceStudioTarget, ctx: StudioDomainContext, message: { type: string }) => void;
}

/** Shared by every studio whose only domain message is "browse" (command, terminal — a working-
 *  directory folder picker); Runbook/Schedule register no domain messages at all. */
async function browseForCwd(ws: WorkspaceStudioTarget, ctx: StudioDomainContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(ws.workspaceRoot),
  });
  if (picked?.[0]) ctx.post(envelope({ type: "cwd" as const, value: picked[0].fsPath }));
}

function handleBrowseDomainMessage(ws: WorkspaceStudioTarget, ctx: StudioDomainContext, message: { type: string }): void {
  if (message.type !== "browse") return;
  void browseForCwd(ws, ctx);
}

// t-610705 (Phase D, D1a) — the type annotation ALONGSIDE `satisfies` (not `satisfies` alone) is
// deliberate: `satisfies` alone infers each entry's own narrow literal type, so an entry missing
// `handleDomainMessage` (runbook/schedule have none) makes `STUDIO_REGISTRY[route.studio]` a union
// where the property doesn't exist on every member — a real error at every generic read site
// (makeStudioDomainDispatch below). The explicit `Record<StudioId, StudioRegistryEntry>` annotation
// widens every entry to the SAME shape for consumers while `satisfies` still enforces the exhaustive-
// key check at the literal (round-2 F14's rule, unchanged).
export const STUDIO_REGISTRY: Record<StudioId, StudioRegistryEntry> = {
  command: {
    legacyViewType: "tachyonCommandStudioShell",
    makeAdapter: (ws) => new CommandStudioAdapter(ws) as unknown as Adapter,
    handleDomainMessage: handleBrowseDomainMessage,
  },
  terminal: {
    legacyViewType: "tachyonTerminalStudioShell",
    makeAdapter: (ws) => new TerminalStudioAdapter(ws) as unknown as Adapter,
    handleDomainMessage: handleBrowseDomainMessage,
  },
  runbook: {
    legacyViewType: "tachyonRunbookStudioShell",
    makeAdapter: (ws) => new RunbookStudioAdapter(ws) as unknown as Adapter,
  },
  schedule: {
    legacyViewType: "tachyonScheduleStudioShell",
    makeAdapter: (ws) => new ScheduleStudioAdapter(ws) as unknown as Adapter,
  },
  agent: {
    legacyViewType: "tachyonAgentStudioShell",
    // t-610705 (Phase D, D1b) — WorkspaceStudioTarget is a structural subset of the
    // WorkspaceAgentStudioTarget AgentStudioAdapter actually needs (
    // readAgentEvolutionOverview/etc); the RUNTIME object (WorkspaceShellHandle) already implements
    // the full agent-specific surface — same "adapter surface collapses to unknown" cast the Adapter
    // alias itself already uses, just one layer up at the workspace-target boundary.
    makeAdapter: (ws) => new AgentStudioAdapter(
      ws as unknown as WorkspaceAgentStudioTarget,
      createAgentEvolutionLabels((message, ...args) => vscode.l10n.t(message, ...args)),
      vscode.l10n.t("When supported, delivered at startup through the selected runtime."),
      createAgentProfileLabels((message, ...args) => vscode.l10n.t(message, ...args)),
    ) as unknown as Adapter,
    handleDomainMessage: (ws, ctx, message) => handleAgentStudioDomainMessage(ws as unknown as WorkspaceAgentStudioTarget, ctx, message),
  },
  task: {
    legacyViewType: "tachyonTaskStudio",
    // t-9dadad — UNLIKE agent (whose surface WorkspaceShellHandle implements flat), the task-studio
    // surface lives as a NESTED sub-target (`handle.taskStudio`, wired since the persistent-engine
    // cutover). D2's flat cast of the whole handle meant `this.target.loadTaskStudio` was undefined
    // at runtime — Task Studio never loaded through Control (infinite "Loading…"); the double-cast
    // hid it from the compiler and no e2e ever opened the studio through this path until the
    // 0.56.94 dogfood did.
    makeAdapter: (ws) => new TaskStudioAdapter(nestedTarget(ws, "taskStudio")) as unknown as Adapter,
    handleDomainMessage: (ws, ctx, message) => handleTaskStudioDomainMessage(nestedTarget(ws, "taskStudio"), ctx, message),
  },
  pin: {
    legacyViewType: "tachyonPinStudio",
    // t-9dadad — same nested-target shape as task above (`handle.pinStudio`).
    makeAdapter: (ws) => new PinStudioAdapter(nestedTarget(ws, "pinStudio")) as unknown as Adapter,
    handleDomainMessage: (ws, ctx, message) => handlePinStudioDomainMessage(nestedTarget(ws, "pinStudio"), ctx, message),
  },
} satisfies Record<StudioId, StudioRegistryEntry>;

export interface CockpitStudios {
  getWorkspaces: () => WorkspaceStudioTarget[];
  /** best-effort fan-out after a successful save/cancel — mirrors every retired
   *  StudioPanelManagerBase host's `onChanged`/`refreshAll` constructor arg (sidebar, other studios'
   *  reference data, etc.). */
  onChanged: () => void;
}

/** Resolves an adapter for `(studio, wsHash)` — undefined when the workspace isn't attached
 *  (revive/deep-link into a detached folder). Same factory shape the retired Control host
 *  (studioHost.ts, deleted in t-337cdf) used. */
export function makeStudioAdapterFactory(deps: CockpitStudios): (route: { studio: StudioId; wsHash: string }) => Adapter | undefined {
  return (route) => {
    const ws = deps.getWorkspaces().find((w) => w.wsHash === route.wsHash);
    if (!ws) return undefined;
    return STUDIO_REGISTRY[route.studio].makeAdapter(ws);
  };
}

/** Domain-message pass-through for the current binding's studio, resolving the SAME workspace
 *  instance the adapter was built from (by wsHash) — the dispatcher stays adapter-generic and never
 *  needs to know which studio-specific browse/import/etc. hooks exist. */
export function makeStudioDomainDispatch(deps: CockpitStudios): (route: { studio: StudioId; wsHash: string }, ctx: StudioDomainContext, message: { type: string }) => void {
  return (route, ctx, message) => {
    const entry = STUDIO_REGISTRY[route.studio];
    if (!entry.handleDomainMessage) return;
    const ws = deps.getWorkspaces().find((w) => w.wsHash === route.wsHash);
    if (!ws) return;
    entry.handleDomainMessage(ws, ctx, message);
  };
}
