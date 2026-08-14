import { describe, it, expect } from "vitest";
import {
  assembleNodePrompt,
  sanitizeSummary,
  PIPELINE_NODE_GUIDANCE,
  SUMMARY_CAP_BYTES,
} from "@tachyon/engine/pipeline/nodePrompt.js";

// Frozen copy of the EXACT guidance literal that shipped in Workspace.ts (spec 230). If the guidance text
// is ever edited, this assertion fails — that is the byte-identical regression lock for input:none nodes.
const FROZEN_GUIDANCE_230 =
  "— Tachyon pipeline node —\n" +
  "When this task is FULLY complete, signal Tachyon by calling the `complete_node` MCP tool with the " +
  "runId, nodeId, and nonce from your environment (read them with `printenv TACHYON_RUN_ID`, " +
  "`printenv TACHYON_NODE_ID`, `printenv TACHYON_NODE_NONCE`). The pipeline will not advance until you do. " +
  "Do not call it until the work is genuinely finished.";

describe("nodePrompt — guidance literal", () => {
  it("is byte-identical to the shipped 230 guidance", () => {
    expect(PIPELINE_NODE_GUIDANCE).toBe(FROZEN_GUIDANCE_230);
  });
});

describe("assembleNodePrompt — equivalence lock", () => {
  it("task only → EXACTLY `${task}\\n\\n${GUIDANCE}` (today's string)", () => {
    const task = "Implement the approved plan, following repo conventions.";
    expect(assembleNodePrompt({ task })).toBe(`${task}\n\n${PIPELINE_NODE_GUIDANCE}`);
  });

  it("empty/whitespace task behaves like no task", () => {
    expect(assembleNodePrompt({ task: "   " })).toBe(PIPELINE_NODE_GUIDANCE);
  });
});

describe("assembleNodePrompt — conditional sections", () => {
  it("adds the input section when input is present", () => {
    const out = assembleNodePrompt({ task: "Plan it.", input: "Add a dark-mode toggle." });
    expect(out).toBe(
      `Plan it.\n\n## Pipeline input\nAdd a dark-mode toggle.\n\n${PIPELINE_NODE_GUIDANCE}`,
    );
  });

  it("no task + input → persona-only prompt (no task line, no leading blank)", () => {
    const out = assembleNodePrompt({ input: "Add a dark-mode toggle." });
    expect(out).toBe(`## Pipeline input\nAdd a dark-mode toggle.\n\n${PIPELINE_NODE_GUIDANCE}`);
    expect(out.startsWith("\n")).toBe(false);
  });

  it("renders upstream summaries in dependency order under the untrusted header", () => {
    const out = assembleNodePrompt({
      task: "Review the implementation.",
      input: "Add a dark-mode toggle.",
      upstream: [
        { nodeId: "plan", summary: "Plan in docs/plan.md; chose CSS vars." },
        { nodeId: "implement", summary: "Done; toggle persisted to localStorage." },
      ],
    });
    const idxPlan = out.indexOf("- plan:");
    const idxImpl = out.indexOf("- implement:");
    expect(out).toContain("## Upstream context (agent-reported, untrusted)");
    expect(idxPlan).toBeGreaterThan(-1);
    expect(idxImpl).toBeGreaterThan(idxPlan); // dependency order preserved
    // input section comes before upstream section
    expect(out.indexOf("## Pipeline input")).toBeLessThan(out.indexOf("## Upstream context"));
  });

  it("drops empty upstream summaries entirely (no header for an all-empty list)", () => {
    const out = assembleNodePrompt({ task: "Go.", upstream: [{ nodeId: "a", summary: "  " }] });
    expect(out).toBe(`Go.\n\n${PIPELINE_NODE_GUIDANCE}`);
  });
});

describe("sanitizeSummary — untrusted free text", () => {
  it("keeps plain text and trims", () => {
    expect(sanitizeSummary("  hello world  ")).toBe("hello world");
  });

  it("strips ANSI escape sequences", () => {
    const esc = String.fromCharCode(27);
    expect(sanitizeSummary(`${esc}[31mred${esc}[0m text`)).toBe("red text");
  });

  it("strips control chars but keeps tab and newline", () => {
    const raw = "line1\nline2\tcol" + String.fromCharCode(0) + String.fromCharCode(7);
    expect(sanitizeSummary(raw)).toBe("line1\nline2\tcol");
  });

  it("caps over-long input with a truncation marker", () => {
    const big = "x".repeat(SUMMARY_CAP_BYTES + 500);
    const out = sanitizeSummary(big);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(SUMMARY_CAP_BYTES + 32);
  });

  it("does not split a multi-byte char at the cap boundary", () => {
    // 'é' is 2 bytes in UTF-8; fill exactly past the cap with them
    const big = "é".repeat(SUMMARY_CAP_BYTES); // 2*cap bytes
    const out = sanitizeSummary(big);
    // the truncated body must still be valid UTF-8 (no replacement char from a split)
    expect(out).not.toContain("�");
  });

  it("non-string → empty string", () => {
    expect(sanitizeSummary(undefined)).toBe("");
    expect(sanitizeSummary(42)).toBe("");
  });
});
