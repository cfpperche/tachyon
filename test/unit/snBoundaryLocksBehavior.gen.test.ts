import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildStarterYaml, type DetectedProject } from "../../apps/vscode-extension/src/init/initLogic.js";

/**
 * Markers that only make sense inside Tachyon's own dev/build/release pipeline.
 * docs/architecture/dogfood-product-boundary.md registry — additions here should be deliberate,
 * since anything on this list becoming a product default/output is exactly the boundary crossing
 * the doc warns about.
 */
const TACHYON_BUILD_MARKERS = [
  "verify:full",
  "esbuild",
  "vsce",
  "record:provenance",
  ".tachyon/deploys",
  "npm run build",
  "docs/specs",
];

const baseFixture = (over: Partial<DetectedProject> = {}): DetectedProject => ({ files: [], installedClis: ["claude"], ...over });

describe("container-generated delegation behavior", () => {
  it("project-agnostic boundaries are pinned: configuration defaults and init output carry no Tachyon-build assumptions", () => {
    // (1) t-e88c8a stage 1 — this used to assert DEFAULT_FULL_VERIFY is undefined, pinning that
    // verify_task carried no product-global full-suite command. The boundary is now satisfied the
    // strongest way available: verify_task is gone, so there is no default left to impose a package
    // manager on a consumer project. Nothing to assert where nothing exists.

    // (2) docs/architecture/dogfood-product-boundary.md — "contributes.configuration defaults carry no
    // Tachyon-repo assumptions". t-aaad95 satisfied that boundary the strongest way available: there
    // are no contributed settings left to carry an assumption. Read the shipped package.json directly
    // (not via import) so this pins the manifest that actually ships, not a cached module.
    //
    // The narrow "no build marker in a default" check moved to settingsAuthorityInventory.test.ts,
    // which now enforces the whole absence rather than the contents of what is present.
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../apps/vscode-extension/package.json"), "utf8"));
    expect(pkgJson.contributes.configuration).toBeUndefined();

    // (3) docs/architecture/dogfood-product-boundary.md — "Tachyon: Init scaffolds from the USER's stack".
    // Generated tachyon.yml must derive purely from the user's own manifests, never embed Tachyon-only
    // commands — checked for both a non-npm fixture and a plain npm fixture.
    const fixtures: DetectedProject[] = [
      baseFixture({ files: ["Cargo.toml"] }),
      baseFixture({ files: ["package.json"], packageJson: { scripts: { dev: "vite", test: "vitest" }, dependencies: { vite: "^5" } } }),
    ];
    for (const fixture of fixtures) {
      const yaml = buildStarterYaml(fixture);
      for (const marker of TACHYON_BUILD_MARKERS) {
        expect(yaml, `generated tachyon.yml (${fixture.files.join(",") || "no manifest"}) should not carry Tachyon-build marker "${marker}"`).not.toContain(marker);
      }
    }
  });
});
