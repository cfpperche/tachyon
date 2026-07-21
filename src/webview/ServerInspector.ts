import type { PaneSnapshot } from "../tmux/TmuxService.js";
import type { TmuxServerSnapshot } from "../inspector/model.js";

export const SERVER_INSPECTOR_VIEW_TYPE = "tachyonServerInspector";

export interface ServerInspectorPanelState {
  schemaVersion: 1;
  view: typeof SERVER_INSPECTOR_VIEW_TYPE;
}

/**
 * t-610705 (SDD 410 Phase B #5) — the standalone tmux Server Inspector webview panel was retired:
 * tmux is a cockpit section only now (Cockpit.ts builds and handles the model/actions independently).
 * `tachyon.inspectServer` opens Control → tmux directly (extension.ts); a revived pre-410 panel
 * disposes itself and redirects the same way, via that command (see the trusted serializer in
 * extension.ts).
 *
 * What survives here is real domain logic, not webview plumbing: the tmux-socket dependency shape
 * shared by Control's embedded tmux section (makeCockpitDeps().inspector reuses this exact shape).
 */
export interface InspectorDeps {
  /** Raw pane snapshot for the whole Tachyon namespace on the socket. */
  snapshot: () => Promise<PaneSnapshot[]>;
  /** Current wsHash -> folder name for open workspaces (for group labels). */
  folderByHash: () => Map<string, string>;
  /** Per-session CPU activity over the last interval (busy=true). Empty off-Linux. */
  cpuBusy: (rows: PaneSnapshot[]) => Map<string, boolean>;
  /** Dedicated Tachyon socket health and best-effort process diagnostics. */
  serverHealth: () => Promise<TmuxServerSnapshot>;
  /** Last lines of a session's pane output. */
  capture: (session: string) => Promise<string>;
  /** Open the session in an editor terminal (attach). */
  open: (session: string) => void;
  /** Kill a session by exact name. */
  kill: (session: string) => Promise<void>;
  /** Reap all dead-pane sessions; returns how many were killed (after a confirm). */
  reapDead: () => Promise<number>;
  /** Reap all sessions owned by closed/foreign workspaces; returns how many (after a confirm). */
  reapOrphans: () => Promise<number>;
}
