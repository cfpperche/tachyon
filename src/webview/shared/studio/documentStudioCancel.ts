import * as vscode from "vscode";

export type DocumentStudioCancelOutcome = "saved" | "discarded" | "editing";

/** Host-owned Cancel guard for document studios that can return from edit mode to read mode. */
export async function confirmDocumentStudioCancel(
  dirty: boolean,
  save: () => Promise<boolean>,
  discard: () => void,
): Promise<DocumentStudioCancelOutcome> {
  if (!dirty) {
    discard();
    return "discarded";
  }
  const saveLabel = vscode.l10n.t("Save");
  const discardLabel = vscode.l10n.t("Discard");
  // Only the two affirmatives are passed, which is this repo's modal idiom (see the Activity share and
  // paste prompts): VS Code appends its own dismiss button, and adding a third "Continue editing" made
  // FOUR buttons of which two did the same thing — the exact redundancy that got the read-mode
  // breadcrumb removed in the first place.
  //
  // The cost of that idiom is real here and is paid in the DETAIL line rather than in a button: the
  // action being confirmed is itself called "Cancel", so a dismiss button labelled "Cancel" is
  // ambiguous on its own. The detail says what dismissing does, so the third option is still offered —
  // as a sentence instead of a duplicate control.
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("This draft has unsaved changes. What would you like to do?"),
    { modal: true, detail: vscode.l10n.t("Dismissing this dialog keeps the draft open for editing.") },
    saveLabel,
    discardLabel,
  );
  if (choice === saveLabel) return await save() ? "saved" : "editing";
  if (choice === discardLabel) {
    discard();
    return "discarded";
  }
  return "editing";
}
