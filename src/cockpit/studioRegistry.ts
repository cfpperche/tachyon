/**
 * t-610705 (SDD 410 Phase D) — the ONE registry keyed by StudioId (studios-routes-design.md): every
 * studio's adapter construction, legacy-serializer viewType, and (when it has one) domain-message
 * handler lives here — nowhere else declares a parallel per-studio list. `satisfies
 * Record<StudioId, ...>` (not a type annotation) so adding a StudioId without a matching entry is a
 * compile error, not a silent `undefined` at a Map lookup (round-2 F14's rule).
 *
 * D0 ships "command" only. D1 (terminal/runbook/schedule/agent), D2 (task), D3 (pin) each add their
 * entry here — this file, `studioIds.ts`, and every exhaustive switch in `route.ts` are the whole
 * checklist; the compiler enforces the rest.
 */
import * as vscode from "vscode";
import type { StudioId } from "./studioIds.js";
import type { StudioHostAdapter } from "../webview/shared/studio/adapter.js";
import type { WorkspaceStudioTarget } from "../shell/WorkspacePresentation.js";
import { CommandStudioAdapter } from "../webview/CommandStudioAdapter.js";
import { envelope } from "../webview/shared/studio/protocol.js";

type Adapter = StudioHostAdapter<unknown, unknown, unknown, unknown>;

export interface StudioDomainContext {
  post: (message: unknown) => void;
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

async function commandBrowse(ws: WorkspaceStudioTarget, ctx: StudioDomainContext): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(ws.workspaceRoot),
  });
  if (picked?.[0]) ctx.post(envelope({ type: "cwd" as const, value: picked[0].fsPath }));
}

export const STUDIO_REGISTRY = {
  command: {
    legacyViewType: "tachyonCommandStudioShell",
    makeAdapter: (ws) => new CommandStudioAdapter(ws) as unknown as Adapter,
    handleDomainMessage: (ws, ctx, message) => {
      if (message.type !== "browse") return;
      void commandBrowse(ws, ctx);
    },
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
 *  (revive/deep-link into a detached folder). `studioHost.ts`'s `StudioAdapterFactory` shape. */
export function makeStudioAdapterFactory(deps: CockpitStudios): (route: { studio: StudioId; wsHash: string }) => Adapter | undefined {
  return (route) => {
    const ws = deps.getWorkspaces().find((w) => w.wsHash === route.wsHash);
    if (!ws) return undefined;
    return STUDIO_REGISTRY[route.studio].makeAdapter(ws);
  };
}

/** Domain-message pass-through for the current binding's studio, resolving the SAME workspace
 *  instance the adapter was built from (by wsHash) — studioHost.ts stays adapter-generic and never
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
