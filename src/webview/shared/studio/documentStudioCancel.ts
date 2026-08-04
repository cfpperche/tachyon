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
  const continueLabel = vscode.l10n.t("Continue editing");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("This draft has unsaved changes. What would you like to do?"),
    { modal: true },
    saveLabel,
    discardLabel,
    continueLabel,
  );
  if (choice === saveLabel) return await save() ? "saved" : "editing";
  if (choice === discardLabel) {
    discard();
    return "discarded";
  }
  return "editing";
}
