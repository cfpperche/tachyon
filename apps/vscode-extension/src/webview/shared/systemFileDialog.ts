/**
 * 515 — the ONE place Tachyon hands a file choice to the operating system.
 *
 * ## Why this exists, after the opposite rule
 *
 * The plugin zip door first shipped with `vscode.window.showOpenDialog` AS the chooser, and the owner
 * refused it: under a remote/WSL window that dialog degrades to a lone "Folder path" text field over
 * the editor, it opens wherever it last was rather than where the archives are, and it knows nothing
 * about what a plugin package is. The product's own picker replaced it.
 *
 * Then the owner named what the replacement was missing, and he is right: **a picker needs both hands.**
 * Typing is fast for whoever already knows the path; clicking is how most people choose a file, and
 * every picker worth benchmarking against — an editor's path field, a desktop app's upload control —
 * offers a "Browse…" beside the box rather than making the human commit to one style. Our picker keeps
 * the fast path AND hands off to the system when that is what someone wants.
 *
 * So the rule was never "never open a native dialog". It is: **the native dialog is never the door you
 * arrive at, only a door you can choose.** Which is why every call funnels through this module — a
 * panel that reaches for `showOpenDialog` on its own is reinstating the default this replaced, and
 * `test/unit/productPicker.test.ts` fails it by name.
 */
import * as vscode from "vscode";

/**
 * Ask the operating system for one `.zip`, on the human's explicit request.
 *
 * `label` names what is being installed so the dialog's confirm button says it ("Install plugin"),
 * rather than the generic "Open" that tells nobody what pressing it does.
 */
export async function chooseZipWithSystemDialog(label: string): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    canSelectFiles: true,
    openLabel: label,
    filters: { "Zip archive": ["zip"] },
  });
  return picked?.[0]?.fsPath;
}
