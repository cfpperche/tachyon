export const RETIRED_BOARD_VIEW_TYPE = "tachyonMissionControl";

/**
 * t-610705 (SDD 410 Phase B #6) retired the standalone Board panel into a Control section.
 * SDD 485 C5 reversed that: the Board is a standalone app again (`src/webview/BoardPanel.ts`, viewType
 * `tachyonBoard`, one panel per project) and `src/webview/board/` now holds both the component
 * and the app's own `main.tsx`.
 *
 * This file is what did NOT come back, and deliberately so: the pre-410 viewType, kept as a types-only
 * record of its persisted-state shape. The trusted serializer in extension.ts disposes a revived pre-410
 * panel and opens the Board APP for `state.wsHash`, so a panel persisted before either migration comes back
 * as the screen it was, in the place that screen lives now. Reusing this viewType for the new app was
 * rejected: one viewType would then mean two incompatible persisted shapes with no way to tell them apart.
 * The literal `"tachyonMissionControl"` must remain unchanged so persisted panels from those builds still
 * match this tombstone and take the redirect path.
 */
export interface RetiredBoardPanelState {
  schemaVersion: 1;
  view: typeof RETIRED_BOARD_VIEW_TYPE;
  wsHash: string;
}
