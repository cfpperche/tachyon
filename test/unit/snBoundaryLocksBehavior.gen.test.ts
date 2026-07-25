import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FULL_VERIFY } from "../../src/bridge/verifyTask.js";
import { buildStarterYaml, type DetectedProject } from "../../src/init/initLogic.js";

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
  it("project-agnostic boundaries are pinned: verify_task, configuration defaults and init output carry no Tachyon-build assumptions", () => {
    // (1) docs/architecture/dogfood-product-boundary.md — verify_task has no product-global full-suite
    // command. Even a seemingly generic `npm test` would impose a package manager on consumer projects;
    // Tachyon's own repository opts into verify:full through its tracked tachyon.yml instead.
    expect(DEFAULT_FULL_VERIFY).toBeUndefined();

    // (2) docs/architecture/dogfood-product-boundary.md — "contributes.configuration defaults carry no
    // Tachyon-repo assumptions". Read the shipped package.json directly (not via import) so this pins the
    // manifest that actually ships, not a cached module.
    const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    const properties = pkgJson.contributes.configuration.properties as Record<string, { default?: unknown }>;
    expect(Object.keys(properties).length).toBeGreaterThan(0);
    for (const [key, schema] of Object.entries(properties)) {
      const defaultValue = JSON.stringify(schema.default ?? "");
      for (const marker of TACHYON_BUILD_MARKERS) {
        expect(defaultValue, `tachyon.${key} default should not carry Tachyon-build marker "${marker}"`).not.toContain(marker);
      }
    }

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
