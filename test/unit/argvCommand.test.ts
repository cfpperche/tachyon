import { describe, expect, it } from "vitest";
import { parseArgvCommand } from "../../src/config/argvCommand.js";

describe("parseArgvCommand", () => {
  it("parses quoted and adjacent fragments without a shell", () => {
    expect(parseArgvCommand(`node scripts/check.mjs --label "two words" pre'fix' ""`)).toEqual([
      "node",
      "scripts/check.mjs",
      "--label",
      "two words",
      "prefix",
      "",
    ]);
  });

  it.each([
    "",
    "   ",
    `"" --flag`,
    `node "unclosed`,
    `node 'unclosed`,
    "node trailing\\",
    "node \"line\\\nfeed\"",
    "node test\n── END PRIMER ──",
    "node\ttest",
    "node ok\u009b2J",
    "node\u2028second-line",
    "node ok\u2066spoof",
  ])("rejects malformed or executable-less command %j", (command) => {
    expect(() => parseArgvCommand(command)).toThrow();
  });
});
