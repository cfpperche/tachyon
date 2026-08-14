/**
 * t-be359b — the folder candidates for a "new …" studio, taken from the sidebar's OWN model.
 *
 * Pure (no preact, no vscode), and separate from `App.tsx` for the same reason
 * `continueTaskCandidates.ts` is separate from `ContinuePicker.tsx`: the candidate rule is the part
 * worth testing, and a unit test cannot import a `.tsx` under the gate's typecheck config.
 */
import type { FleetVM } from "@tachyon/shared/sidebar/types.js";

/**
 * The subset of `QuickPickerItem` these rows fill in. Declared here rather than imported because
 * `QuickPicker.tsx` is JSX and this module must stay importable from a unit test. It is not a
 * hand-kept copy that can drift: `App.tsx` assigns the result to `QuickPickerItem[]`, so a shape
 * that stops fitting the picker fails the build there.
 */
export interface StudioFolderItem {
  id: string;
  label: string;
  description?: string;
}

/**
 * The host's `pickFolderForCreate` offers exactly the CONFIGURED workspaces, and that is what one
 * `FleetVM` per root already is — so this surface owns the candidate set and does not need the host
 * to hand it over. A fleet whose `folder` ref is missing (fixtures and plugin projections may omit
 * it) cannot be named or resolved, so it is dropped rather than listed as a blank row.
 *
 * The native list described each folder by its Bridge URL; the webview's projection carries the
 * PORT, which is the part that actually differs between roots, so that is what the row shows.
 */
export function studioFolderItems(fleets: readonly FleetVM[]): StudioFolderItem[] {
  return fleets
    .filter((f) => f.folder?.hash && f.folder.name)
    .map((f) => ({
      id: f.folder!.hash,
      label: f.folder!.name,
      ...(f.bridge?.port ? { description: `Bridge :${f.bridge.port}` } : {}),
    }));
}
