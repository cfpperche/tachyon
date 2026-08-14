import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { openingPromptCapability } from "../../src/agents/openingPromptCapability.js";
import { runtimePromptAdapter } from "@tachyon/shared/agents/runtimePromptAdapters.js";
import { piBridgeCmd } from "../../src/config/loadConfig.js";

const EXTENSION = "/immutable/engine/pi-bridge-extension.mjs";

describe("Pi runtime onboarding", () => {
  it("delivers opening prompts through Pi's positional startup message", () => {
    expect(openingPromptCapability("pi")).toEqual({
      status: "prompt",
      runtime: "pi",
      channel: "startup-argument",
    });
    expect(runtimePromptAdapter("env FOO=1 pi")?.compose?.("'primer text'")).toBe("'primer text'");
  });

  it("injects the immutable extension immediately after direct/env/npx Pi binaries", () => {
    expect(piBridgeCmd("pi 'primer text'", EXTENSION))
      .toBe(`pi --extension '${EXTENSION}' 'primer text'`);
    expect(piBridgeCmd("env FOO=1 pi --model sonnet 'primer text'", EXTENSION))
      .toBe(`env FOO=1 pi --extension '${EXTENSION}' --model sonnet 'primer text'`);
    expect(piBridgeCmd("npx pi 'primer text'", EXTENSION))
      .toBe(`npx pi --extension '${EXTENSION}' 'primer text'`);
  });

  it("is idempotent and leaves non-Pi commands byte-identical", () => {
    const once = piBridgeCmd("pi 'primer text'", EXTENSION);
    expect(piBridgeCmd(once, EXTENSION)).toBe(once);
    const spaced = piBridgeCmd("pi 'primer text'", "/immutable engine/pi-bridge-extension.mjs");
    expect(piBridgeCmd(spaced, "/immutable engine/pi-bridge-extension.mjs")).toBe(spaced);
    expect(piBridgeCmd("claude 'primer text'", EXTENSION)).toBe("claude 'primer text'");
  });

  it("locks the Pi extension into the authenticated persistent-engine build boundary", () => {
    const build = fs.readFileSync("esbuild.mjs", "utf8");
    expect(build).toContain('entryPoints: ["src/pi-bridge-extension/index.ts"]');
    expect(build).toContain('outfile: "dist/engine/pi-bridge-extension.mjs"');
    expect(build).toContain('{ path: "pi-bridge-extension.mjs", sha256: sha256File("dist/engine/pi-bridge-extension.mjs") }');
  });
});
