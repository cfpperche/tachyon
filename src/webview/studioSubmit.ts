import type { StudioSubmit } from "@tachyon/engine/webview/studioSubmit.js";
export type { StudioSubmit } from "@tachyon/engine/webview/studioSubmit.js";
import type * as vscode from "vscode";
import type { EntryKind } from "@tachyon/engine/config/loadConfig.js";
import type { StudioSaveResult } from "@tachyon/engine/webview/shared/studio/adapter.js";

export interface StudioDeps {
  extensionUri: vscode.Uri;
  detectClis: () => Promise<string[]>;
  takenNames: () => string[];
  /** Declared commands: names. Drives Runbook step resolution. */
  commandNames: () => string[];
  defaultCwd: string;
  suggestKindForCommand: (cmd: string) => EntryKind;
  onSubmit: (submit: StudioSubmit) => string[] | undefined | Promise<string[] | undefined>;
}

/** Preserves the legacy synchronous adapter path while allowing a remote target to resolve asynchronously.
 *  `newEntityId` (t-610705, Phase D, D1d) — pass the patch's own name ONLY when this save call was for a
 *  NEW entity (the adapter's own `entityId` param was `undefined`); every one of the 5 studio adapters'
 *  `TPatch` is `FormState` (always carries `.name`), so this is the same value across all of them —
 *  see StudioSaveResult's own doc comment for why the host needs it back. Trusting `patch.name` as the
 *  persisted key (rather than reading an id back from persistence) is safe ONLY because
 *  `Workspace.studioSubmit` (workspace/Workspace.ts) writes it VERBATIM as the YAML block key
 *  (`upsertCommand`/`upsertAgent`/etc. take `submit.state.name` directly, no normalization) and
 *  rejects — via the kind-specific form validator, returned as the `errors` array below — before this
 *  ever reaches the "ok" branch. If a future persistence path ever normalizes/slugifies a submitted
 *  name, this assumption breaks and `newEntityId` must come from that path's own return value instead. */
export function mapStudioSubmitResult(
  result: string[] | undefined | Promise<string[] | undefined>,
  errorCode: string,
  newEntityId?: string,
): StudioSaveResult | Promise<StudioSaveResult> {
  const map = (errors: string[] | undefined): StudioSaveResult => errors && errors.length > 0
    ? { status: "error", error: { code: errorCode, message: errors.join("; "), source: "validation" } }
    : { status: "ok", ...(newEntityId !== undefined ? { entityId: newEntityId } : {}) };
  return result && typeof (result as Promise<string[] | undefined>).then === "function"
    ? Promise.resolve(result).then(map)
    : map(result as string[] | undefined);
}
