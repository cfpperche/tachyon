import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOCKET_NAME, TmuxService } from "@tachyon/engine/tmux/TmuxService.js";

describe("t-7a7ddf development env stays out of the installed product", () => {
  it("TmuxService uses the socket name it was given, not the process environment", async () => {
    const calls: string[][] = [];
    const tmux = new TmuxService(async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    }, "given-socket");
    await tmux.hasSession("any");
    expect(calls[0]?.slice(0, 2)).toEqual(["-L", "given-socket"]);
    expect(calls[0]).not.toContain(DEFAULT_SOCKET_NAME);
  });

  it("extension.ts evaluates Dev Host profile home once, gated by extensionMode", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../apps/vscode-extension/src/extension.ts"),
      "utf8",
    );
    expect(source.match(/TACHYON_DEV_HOST_PROFILE_HOME/g)?.length).toBe(3);
    expect(source).toMatch(/const devProfileHome =\s*context\.extensionMode === vscode\.ExtensionMode\.Development/);
    expect(source).toMatch(/const home = devProfileHome \? \{ homeDir: devProfileHome \} : \{\};/);
    expect(source).not.toMatch(/const profileHome = process\.env\.TACHYON_DEV_HOST === "1"/);
  });
});
