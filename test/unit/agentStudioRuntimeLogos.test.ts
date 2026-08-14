import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Agent Studio runtime logos", () => {
  it("quick-add chips carry official runtime logos", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "packages/webview-ui/src/webview/agent-studio-shell/runtimeLogos.tsx"), "utf8");
    const ids = [
      "claude",
      "codex",
      "agy",
      "gemini",
      "opencode",
      "copilot",
      "aider",
      "goose",
      "amp",
      "grok",
      "qwen",
      "cursor-agent",
      "pi",
      "hermes",
      "verboo",
    ];
    for (const id of ids) expect(source).toContain(`"${id}"`);
    expect(source).not.toContain("circle-slash");
    expect(source).not.toContain('"check"');
  });
});
