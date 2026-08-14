import { describe, expect, it } from "vitest";
import fs from "node:fs";
// The build helper is plain ESM with no separate declaration surface. Importing the exact helper
// esbuild uses is the point of this regression test.
// @ts-expect-error -- plain build-script module, exercised directly
import { parseEngineShellProtocol, readEngineShellProtocol } from "../../scripts/engine-protocol.mjs";
import { ENGINE_SHELL_PROTOCOL } from "@tachyon/engine/engine-service/protocol.js";

describe("engine manifest protocol source", () => {
  it("derives the build value from the runtime protocol authority", () => {
    expect(readEngineShellProtocol()).toBe(ENGINE_SHELL_PROTOCOL);
    expect(fs.readFileSync("esbuild.mjs", "utf8")).not.toMatch(
      /protocol:\s*\{\s*min:\s*[0-9]+\s*,\s*max:\s*[0-9]+\s*\}/,
    );
  });

  it("fails closed when the authority is missing or ambiguous", () => {
    expect(() => parseEngineShellProtocol("export const OTHER = 5 as const;"))
      .toThrow(/found 0/);
    expect(() => parseEngineShellProtocol([
      "export const ENGINE_SHELL_PROTOCOL = 5 as const;",
      "export const ENGINE_SHELL_PROTOCOL = 6 as const;",
    ].join("\n"))).toThrow(/found 2/);
  });

  it("accepts only a positive safe integer literal", () => {
    expect(() => parseEngineShellProtocol("export const ENGINE_SHELL_PROTOCOL = 0 as const;"))
      .toThrow(/found 0/);
    expect(() => parseEngineShellProtocol(
      "export const ENGINE_SHELL_PROTOCOL = 999999999999999999999 as const;",
    )).toThrow(/safe integer/);
  });
});
