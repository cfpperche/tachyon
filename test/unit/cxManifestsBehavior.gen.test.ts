import { describe, expect, it } from "vitest";
import { evaluateAttentionManifest } from "@tachyon/shared/attention/manifestEngine.js";
import { ATTENTION_MANIFEST_RUNTIMES, attentionManifestForRuntime } from "@tachyon/shared/attention/manifests.js";

describe("container-generated delegation behavior", () => {
  it("attention detection is driven by per-runtime manifests and preserves current verdicts for claude codex grok opencode pi", () => {
    const cases: Array<{ name: string; pane: string; kind: "prompt" | "error" | "stall" | null; state: "needs-input" | "throttled" | null; line?: string }> = [
      {
        name: "real Claude trust prompt",
        pane: `
────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:
 /tmp
 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ 1. Yes, I trust this folder
   2. No, exit
 Enter to confirm · Esc to cancel
`,
        kind: "prompt",
        state: "needs-input",
        line: "Enter to confirm · Esc to cancel",
      },
      { name: "common y/n prompt", pane: "installing...\nContinue? [y/n] ", kind: "prompt", state: "needs-input", line: "Continue? [y/n]" },
      { name: "provider rate limit", pane: "Error: rate limit exceeded, please try again later", kind: "error", state: "throttled", line: "Error: rate limit exceeded, please try again later" },
      {
        name: "newer prompt beats older error",
        pane: ["Rate limit hit, retrying...", "some other log line", "Switch provider? [y/n]"].join("\n"),
        kind: "prompt",
        state: "needs-input",
        line: "Switch provider? [y/n]",
      },
      { name: "same-line prompt and error ties to error", pane: "Rate limit exceeded - continue? [y/n]", kind: "error", state: "throttled" },
      { name: "connection drop stall", pane: "API Error: Connection closed mid-response", kind: "stall", state: "needs-input" },
      {
        name: "opencode runtime error JSON",
        pane: ["Error: {", "  \"name\": \"UnknownError\",", "  \"data\": {", "    \"message\": \"Unexpected server error. Check server logs for details.\",", "    \"ref\": \"err_7b6cbec9\"", "  }", "}"].join("\n"),
        kind: "stall",
        state: "needs-input",
        line: "\"message\": \"Unexpected server error. Check server logs for details.\",",
      },
      { name: "ordinary output", pane: "compiled successfully in 1.2s\nwaiting for changes", kind: null, state: null },
      { name: "bare status code false positive guard", pane: "server listening on port 429", kind: null, state: null },
      { name: "unqualified API error false positive guard", pane: "API Error: file not found", kind: null, state: null },
    ];

    const resolved = ATTENTION_MANIFEST_RUNTIMES.map((runtime) => ({ runtime, manifest: attentionManifestForRuntime(runtime) }));

    for (const { runtime, manifest } of resolved) {
      expect(manifest.runtime).toBe(runtime);
      expect(manifest.version).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d+$/);
      expect(manifest.evidence.length).toBeGreaterThan(0);
      for (const c of cases) {
        const match = evaluateAttentionManifest(manifest, c.pane);
        expect(match?.kind ?? null, `${runtime}: ${c.name} kind`).toBe(c.kind);
        expect(match?.rule.state ?? null, `${runtime}: ${c.name} state`).toBe(c.state);
        if (c.line) expect(match?.line, `${runtime}: ${c.name} line`).toBe(c.line);
      }
    }

    // Overlays are the ONLY sanctioned way a runtime's rule set may differ from base, and each one
    // must be measured. t-4e6ba5 landed the first (grok's native tool-authorization modal). Every
    // other runtime must still resolve base exactly — this is what catches an accidental divergence
    // or an overlay that quietly leaks into peers.
    const OVERLAY_RUNTIMES = new Set(["grok"]);
    const base = resolved.find((entry) => !OVERLAY_RUNTIMES.has(entry.runtime))!;
    for (const { runtime, manifest } of resolved) {
      if (OVERLAY_RUNTIMES.has(runtime)) {
        // An overlay EXTENDS base: every base rule survives, and the overlay adds at least one.
        expect(manifest.rules.length, `${runtime} should extend base, not replace it`).toBeGreaterThan(base.manifest.rules.length);
        for (const rule of base.manifest.rules) {
          expect(manifest.rules, `${runtime} dropped base rule ${rule.id}`).toContainEqual(rule);
        }
        continue;
      }
      expect(manifest.rules, `${runtime} rules should equal ${base.runtime} rules (it has no overlay)`).toEqual(base.manifest.rules);
    }
  });
});
