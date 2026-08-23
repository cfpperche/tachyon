/**
 * 515 — the system's file dialog is a door you CHOOSE, never the door you arrive at.
 *
 * ## The rule, and how it got its final shape
 *
 * The plugin zip door first shipped with `vscode.window.showOpenDialog` as the chooser, and the owner
 * refused it on sight: under a remote/WSL window that dialog degrades to a lone "Folder path" text
 * field over the editor, it opens wherever it last was rather than where the archives are, and it
 * knows nothing about what a plugin package is. The product's own `PathPicker` replaced it, and this
 * file's first version said, flatly, that these panels must never mention `showOpenDialog`.
 *
 * That was too blunt, and the owner said so in the next breath: **a picker needs both hands.** Typing
 * is fast for whoever already knows the path; clicking through folders is how most people choose a
 * file, and every picker worth benchmarking against offers a "Browse…" beside the box rather than
 * making the human commit to one style. A rule that forbids the native dialog outright forbids the
 * escape hatch too.
 *
 * So what is actually pinned here is the ordering, which is the part that was ever in question:
 *
 *   1. No panel opens a native dialog on its own — every handoff goes through `systemFileDialog.ts`,
 *      so "who hands a file choice to the OS" is one grep and not a habit spread across surfaces.
 *   2. The archive-install doors open OUR picker. They must feed it real candidates, so that deleting
 *      the dialog can never pass by deleting the feature.
 *   3. Our picker offers the system dialog as an explicit second hand.
 *
 * Checked instead of remembered because it already failed once WITH the instruction on record: the app
 * installer had been rebuilt around `PathPicker` two specs earlier, and the plugin door reached for the
 * dialog anyway.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const HANDOFF = "apps/vscode-extension/src/webview/shared/systemFileDialog.ts";

/** The panels that install a Tachyon artefact from an archive. */
const ARCHIVE_INSTALL_DOORS = [
  "apps/vscode-extension/src/webview/PluginsPanel.ts",
  "apps/vscode-extension/src/webview/SidebarPrototype.ts",
];

/**
 * The app install command, which is reached from the sidebar picker, from "Browse…", and from the
 * Command Palette. It lives in `extension.ts`, which also holds dialogs this rule does NOT govern —
 * `restoreStateBackup` asks for a destination FOLDER, which `PathPicker` (directories and `.zip`
 * files, choosing a file) is the wrong tool for. So the assertion here is about the command, not
 * about the file it happens to live in.
 */
const APP_INSTALL_COMMAND = "apps/vscode-extension/src/extension.ts";

const read = (file: string): string => readFileSync(file, "utf8");

describe("515 — the archive-install doors open the product's picker", () => {
  for (const file of ARCHIVE_INSTALL_DOORS) {
    it(`${file} never opens a native dialog on its own`, () => {
      expect(read(file)).not.toContain("showOpenDialog");
    });
  }

  it("the app install command hands off through the shared module, not a dialog of its own", () => {
    const source = read(APP_INSTALL_COMMAND);
    const command = source.slice(source.indexOf('registerCommand("tachyon.installApp"'));
    const body = command.slice(0, command.indexOf("registerCommand(", 1));
    expect(body).toContain("chooseZipWithSystemDialog");
    expect(body).not.toContain("showOpenDialog");
  });

  it("the plugins panel feeds the picker, so removing the dialog cannot pass by removing the feature", () => {
    const source = read(ARCHIVE_INSTALL_DOORS[0]!);
    expect(source).toContain("findZipCandidates");
    expect(source).toContain("browseForZip");
    expect(source).toContain("zipsMessage");
  });

  it("the handoff to the OS lives in exactly one module, and says why it may be reached", () => {
    const source = read(HANDOFF);
    expect(source).toContain("showOpenDialog");
    // The comment is the load-bearing part: the next person to touch this must find the rule here.
    expect(source).toMatch(/never the door you/);
  });

  it("the picker offers the system dialog as a second hand, not as the only one", () => {
    const picker = read("packages/webview-ui/src/webview/shared/ui/PathPicker.tsx");
    expect(picker).toContain("onSystemBrowse");
    // Optional on purpose: a surface with no system dialog to offer must not draw a dead button.
    expect(picker).toContain("onSystemBrowse?:");
    expect(picker).toContain("{onSystemBrowse ?");
    // And both hands still reach the same place: typing a path is not a lesser door.
    expect(picker).toContain("looksLikePath(query)");
  });
});
