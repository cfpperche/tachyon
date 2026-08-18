import type { StudioRestoreSnapshot } from "@tachyon/webview-ui/webview/shared/studio/protocol";

/** Persisted panel identity for a pre-410 / legacy studio serializer. Types-only: no runtime. */
export interface StudioPanelState<TPatch> {
  schemaVersion: 1;
  view: string;
  wsKey: string;
  snapshot: StudioRestoreSnapshot<string, TPatch>;
}
