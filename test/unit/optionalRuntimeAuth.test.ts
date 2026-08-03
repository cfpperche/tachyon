import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { optionalRuntimeCredential } from "../helpers/optionalRuntimeAuth.js";

describe("optional runtime auth test setup (t-eccb00)", () => {
  it("resolves the same host credential locations as the harness", () => {
    expect(optionalRuntimeCredential("claude", {}, "/home/tester"))
      .toBe(path.join("/home/tester", ".claude", ".credentials.json"));
    expect(optionalRuntimeCredential("codex", {}, "/home/tester"))
      .toBe(path.join("/home/tester", ".codex", "auth.json"));
    expect(optionalRuntimeCredential("opencode", {}, "/home/tester"))
      .toBe(path.join("/home/tester", ".local", "share", "opencode", "auth.json"));
  });

  it("honors the runtime-owned home overrides", () => {
    expect(optionalRuntimeCredential("claude", { CLAUDE_CONFIG_DIR: "/auth/claude" }, os.homedir()))
      .toBe(path.join("/auth/claude", ".credentials.json"));
    expect(optionalRuntimeCredential("codex", { CODEX_HOME: "/auth/codex" }, os.homedir()))
      .toBe(path.join("/auth/codex", "auth.json"));
    expect(optionalRuntimeCredential("opencode", { XDG_DATA_HOME: "/auth/data" }, os.homedir()))
      .toBe(path.join("/auth/data", "opencode", "auth.json"));
  });
});
