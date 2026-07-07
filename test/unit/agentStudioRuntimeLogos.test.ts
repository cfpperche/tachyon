import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Agent Studio runtime logos", () => {
  it("covers every stable quick-add catalog id without falling back to generic status icons", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/webview/agent-studio-shell/runtimeLogos.tsx"), "utf8");
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
    ];
    for (const id of ids) expect(source).toContain(`"${id}"`);
    expect(source).not.toContain("circle-slash");
    expect(source).not.toContain('"check"');
  });
});
