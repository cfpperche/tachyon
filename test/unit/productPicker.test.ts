/**
 * 515 — installing a Tachyon artefact uses TACHYON's chooser.
 *
 * The rule is the owner's, stated after the plugin zip door shipped with `vscode.window.showOpenDialog`
 * in it: the editor's file dialog is not ours to reach for. It is a separate window with its own theme
 * and its own keyboard; under a remote/WSL window it degrades to a single "Folder path" text field
 * floating over the editor; it opens wherever it last was rather than where the archives are; and it
 * knows nothing about what a plugin package is. `PathPicker` opens on the archives already lying around,
 * filters and navigates from one input, and is drawn in the panel that asked for it.
 *
 * This is checked rather than remembered because it has already failed once with the instruction on
 * record — the app installer had been rebuilt around the product picker two specs earlier, and the
 * plugin door still reached for the dialog. An instruction that did not hold the first time is a
 * mechanism problem, not a diligence problem.
 *
 * ## What this does NOT claim
 *
 * That no host code may ever open a native dialog. Other call sites choose things outside Tachyon's
 * vocabulary — a workspace folder, an arbitrary HTML file to import — where a general-purpose file
 * dialog is the honest tool and `PathPicker` (which lists directories and `.zip` files) would be the
 * wrong one. The rule pinned here is narrow and is the one that was broken: the doors that install a
 * Tachyon artefact from an archive.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const ARCHIVE_INSTALL_DOORS = [
  "apps/vscode-extension/src/webview/PluginsPanel.ts",
  "apps/vscode-extension/src/webview/SidebarPrototype.ts",
];

describe("515 — the archive-install doors use the product's own picker", () => {
  for (const file of ARCHIVE_INSTALL_DOORS) {
    it(`${file} never opens the editor's file dialog`, () => {
      expect(readFileSync(file, "utf8")).not.toContain("showOpenDialog");
    });
  }

  it("the plugins panel answers the picker instead, from the shared zip browser", () => {
    const source = readFileSync(ARCHIVE_INSTALL_DOORS[0]!, "utf8");
    // Not just "no dialog" — the door has to actually feed a picker, or removing the dialog would
    // pass this file by deleting the feature.
    expect(source).toContain("findZipCandidates");
    expect(source).toContain("browseForZip");
    expect(source).toContain("zipsMessage");
  });
});
