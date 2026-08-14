import { describe, expect, it } from "vitest";
import { evaluateAttentionManifest } from "@tachyon/shared/attention/manifestEngine.js";
import { BASE_MANIFEST, resolveManifest, type ManifestOverlay } from "@tachyon/shared/attention/manifests.js";

describe("attention manifest overlay seam", () => {
  it("has no shipped overlays today — every runtime falls through to the base manifest untouched", () => {
    const manifest = resolveManifest(BASE_MANIFEST, undefined, "codex");
    expect(manifest.runtime).toBe("codex");
    expect(manifest.version).toBe(BASE_MANIFEST.version);
    expect(manifest.evidence).toBe(BASE_MANIFEST.evidence);
    expect(manifest.rules).toEqual(BASE_MANIFEST.rules);
  });

  it("merges a synthetic overlay: overrides an existing rule by id and extends with a new one", () => {
    // Fixture only — proves the seam works, not a claim about any real runtime's chrome.
    const syntheticOverlay: ManifestOverlay = {
      version: "2099.01.01.1",
      evidence: "SYNTHETIC TEST FIXTURE — not a real measurement.",
      rules: [
        {
          // Overrides the base "default_prompt" rule: same id, higher priority, narrower matcher.
          id: "default_prompt",
          state: "needs-input",
          kind: "prompt",
          priority: 200,
          region: { bottom_non_empty_lines: 8 },
          evidence: "SYNTHETIC: overridden default_prompt with higher priority.",
          matcher: { lineRegex: "\\bsynthetic overlay prompt\\b", flags: "i" },
        },
        {
          // Extends the base rule set: a novel id not present in base.json.
          id: "synthetic_overlay_only_rule",
          state: "needs-input",
          kind: "prompt",
          priority: 300,
          region: { bottom_non_empty_lines: 8 },
          evidence: "SYNTHETIC: new rule only present via overlay.",
          matcher: { lineRegex: "\\bsynthetic overlay only\\b", flags: "i" },
        },
      ],
    };

    const merged = resolveManifest(BASE_MANIFEST, syntheticOverlay, "codex");

    expect(merged.runtime).toBe("codex");
    expect(merged.version).toBe(syntheticOverlay.version);
    expect(merged.evidence).toContain(BASE_MANIFEST.evidence);
    expect(merged.evidence).toContain(syntheticOverlay.evidence);

    // Extend: base rule count plus exactly one brand-new id.
    expect(merged.rules).toHaveLength(BASE_MANIFEST.rules.length + 1);
    expect(merged.rules.map((r) => r.id)).toContain("synthetic_overlay_only_rule");

    // Override: the id is not duplicated, and the overlay's version of the rule wins.
    const overridden = merged.rules.filter((r) => r.id === "default_prompt");
    expect(overridden).toHaveLength(1);
    expect(overridden[0]?.priority).toBe(200);

    // Override changes matching behavior: base default_prompt would no longer match this
    // pane (its old matcher looked for y/n-style phrasing), the overlay's narrower one does.
    const overrideOnlyPane = "please respond to this synthetic overlay prompt now";
    const baseMatch = evaluateAttentionManifest(resolveManifest(BASE_MANIFEST, undefined, "codex"), overrideOnlyPane);
    expect(baseMatch).toBeNull();
    const overlayMatch = evaluateAttentionManifest(merged, overrideOnlyPane);
    expect(overlayMatch?.rule.id).toBe("default_prompt");
    expect(overlayMatch?.rule.priority).toBe(200);

    // Extend: the brand-new rule id is reachable and wins on its own higher priority.
    const extendPane = "a synthetic overlay only marker line";
    const extendMatch = evaluateAttentionManifest(merged, extendPane);
    expect(extendMatch?.rule.id).toBe("synthetic_overlay_only_rule");
    expect(extendMatch?.rule.priority).toBe(300);
  });
});
