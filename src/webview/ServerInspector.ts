import type { PaneSnapshot } from "@tachyon/engine/tmux/TmuxService.js";
import type { TmuxServerSnapshot } from "@tachyon/webview-ui/inspector/model";

/**
 * SDD 485 D1 (2026-08-03) — what is left of this file is real DOMAIN logic and nothing else: the
 * tmux-socket dependency shape the inspector reads through. The panel machinery it used to describe came
 * back, but not here — `src/webview/TmuxPanel.ts` is the live host now, and it owns the viewType
 * (`TMUX_VIEW_TYPE`, still the string 410 retired) and the persisted state (`SectionPanelState`, which for
 * a `window` app is byte-identical to the tombstone's).
 *
 * History, because it is the reason the viewType did not change: t-610705 (SDD 410 Phase B #5) retired the
 * standalone panel and made tmux a Control section, leaving this file a types-only stub with a
 * `SERVER_INSPECTOR_VIEW_TYPE` + `ServerInspectorPanelState` pair used only by a dispose-and-redirect
 * serializer. Both are gone with the redirect they served.
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
