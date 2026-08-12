import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyComposerSubmission, composerText } from "../../src/runtime/composerRegion.js";
import type { ResumeRuntime } from "../../src/resume/adapters.js";
import { runtimeProfile } from "../../src/runtime/runtimeProfile.js";

/**
 * t-ba5357 — real `capture-pane` bytes from 220-column panes, one runtime at a time, driven through
 * production's load-buffer + bracketed-paste gesture. A lost Enter leaves exactly these wrapped
 * drafts staged. Before each runtime declared its own continuation rule, the reader recovered only
 * row one and falsely classified that state as `cleared`, disabling the retry loop.
 *
 * OpenCode 1.18.15 is deliberately absent: that same gesture renders only `[Pasted ~1 lines]`, not
 * the staged bytes, so no continuation regex can make the existing reader confirm its delivery.
 */

const cases: Array<{ runtime: ResumeRuntime; version: string; fixture: string }> = [
  { runtime: "claude", version: "Claude Code 2.1.228", fixture: "claude-composer-wrap" },
  { runtime: "hermes", version: "Hermes Agent 0.18.2", fixture: "hermes-composer-wrap" },
];

const read = (fixture: string, name: string): string =>
  fs.readFileSync(path.resolve(__dirname, "../fixtures", fixture, name), "utf8").replace(/\s+$/, "");

describe.each(cases)("$runtime composer wrap — measured on $version (t-ba5357)", ({ runtime, fixture }) => {
  const composer = runtimeProfile(runtime)!.composer!;
  const pane = read(fixture, "wrapped-staged.pane.txt");
  const staged = read(fixture, "wrapped-staged.text.txt");

  it("reads the complete wrapped logical line from the real pane", () => {
    expect(composer.continuationLine).toBeDefined();
    expect(composerText(pane, composer)).toBe(staged);
  });

  it("classifies the lost-Enter state as still holding text", () => {
    expect(classifyComposerSubmission(pane, composer, staged)).toBe("holds-text");
  });
});

it("keeps Grok undeclared because its measured border survives the unchanged shared stripper", () => {
  const grok = runtimeProfile("grok")!.composer!;
  const pane = read("grok-composer-wrap", "wrapped-staged.pane.txt");
  const staged = read("grok-composer-wrap", "wrapped-staged.text.txt");
  expect(grok.continuationLine).toBeUndefined();
  expect(composerText(pane, { ...grok, continuationLine: /^ {2}│ {3}\S/ })).toContain("│");
  expect(classifyComposerSubmission(pane, { ...grok, continuationLine: /^ {2}│ {3}\S/ }, staged)).toBe("cleared");
});

it("keeps OpenCode undeclared because its real production paste exposes no staged bytes", () => {
  const opencode = runtimeProfile("opencode")!.composer!;
  const pane = read("opencode-composer-wrap", "wrapped-staged.pane.txt");
  expect(opencode.continuationLine).toBeUndefined();
  expect(composerText(pane, opencode)).toBeNull();
  expect(pane).toContain("[Pasted ~1 lines]");
});
