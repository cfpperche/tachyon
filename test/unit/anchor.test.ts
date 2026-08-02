import { describe, it, expect } from "vitest";
import { contextRenewalGesture, detectCompaction, compactionRuntimes } from "../../src/anchor/compaction.js";

describe("compaction detection (spec 216 Part C)", () => {
  it("covers claude + codex only (D-C)", () => {
    expect(compactionRuntimes().sort()).toEqual(["claude", "codex"]);
  });

  it("keeps measured renewal gestures fail-closed by runtime", () => {
    expect(contextRenewalGesture("claude", "compact")).toBe("/compact");
    expect(contextRenewalGesture("claude", "fresh")).toBe("/clear");
    expect(contextRenewalGesture("codex", "fresh")).toBe("/new");
    expect(contextRenewalGesture("grok", "fresh")).toBe("/new");
    expect(contextRenewalGesture("gemini", "compact")).toBeUndefined();
  });

  it("detects a claude compaction banner", () => {
    expect(detectCompaction("claude", "… Compacting conversation history …")).toBe(true);
    expect(detectCompaction("claude --resume x", "Conversation compacted (saved 40k tokens)")).toBe(true);
  });

  it("detects a codex summarization banner", () => {
    expect(detectCompaction("codex", "Summarizing conversation to free context…")).toBe(true);
  });

  it("does not fire on ordinary output", () => {
    expect(detectCompaction("claude", "running tests… all green")).toBe(false);
    expect(detectCompaction("codex", "edited 3 files")).toBe(false);
  });

  it("returns false for runtimes without a detector (documented gap)", () => {
    expect(detectCompaction("gemini -i x", "Compacting conversation")).toBe(false);
    expect(detectCompaction("opencode", "Summarizing conversation")).toBe(false);
  });

  it("returns false for an unrecognized command", () => {
    expect(detectCompaction("npm run dev", "Compacting conversation")).toBe(false);
  });
});
