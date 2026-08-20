/**
 * t-0ba30f — Integrated Browser state is read from config.ideBrowser.enabled, not companion.status.
 *
 * The hitch was a Settings round-trip shortcut (7fe4b3a19 / 488 F4). The gate itself lives in
 * settings.ideBrowser.enabled. These tests hit the production doors: the engine query, the
 * companion.status payload, and the shell helper Control collect actually calls.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeExtensionQuery } from "@tachyon/engine/engine-service/extensionOperationService.js";
import { isExtensionCommandV1, isExtensionQueryV1 } from "@tachyon/engine/runtime-api/extensionOperations.js";
import { readIdeBrowserEnabled } from "../../apps/vscode-extension/src/webview/ideBrowserControlState.js";

function companionWorkspace(ideEnabled: boolean) {
  return {
    workspaceRoot: "/tmp/ide-browser-uncouple",
    config: { settings: { ideBrowser: { enabled: ideEnabled }, companion: {} } },
    companion: {
      listDevices: () => [],
      hasPairedDevice: () => false,
    },
    companionLive: { hasLiveClient: () => false },
    companionBaseUrl: () => "http://127.0.0.1:1",
    companionBaseUrlCandidates: () => ["http://127.0.0.1:1"],
  };
}

describe("t-0ba30f — Integrated Browser read is not a companion.status hitch", () => {
  describe("engine query config.ideBrowser.enabled", () => {
    it("is a query (no payload) and still a write command (with enabled)", () => {
      expect(isExtensionQueryV1({ action: "config.ideBrowser.enabled" })).toBe(true);
      expect(isExtensionCommandV1({ action: "config.ideBrowser.enabled", enabled: true })).toBe(true);
      expect(isExtensionQueryV1({ action: "config.ideBrowser.enabled", enabled: true })).toBe(false);
    });

    it.each([
      [true, true],
      [false, false],
    ] as const)("enabled %s → %s", async (configured, expected) => {
      const payload = await executeExtensionQuery(
        { workspace: companionWorkspace(configured) as never },
        { action: "config.ideBrowser.enabled" },
      );
      expect(payload).toEqual({ enabled: expected });
    });

    it("absent settings.ideBrowser is off", async () => {
      const workspace = companionWorkspace(false);
      workspace.config = { settings: { companion: {} } } as never;
      const payload = await executeExtensionQuery(
        { workspace: workspace as never },
        { action: "config.ideBrowser.enabled" },
      );
      expect(payload).toEqual({ enabled: false });
    });
  });

  describe("companion.status", () => {
    it("no longer carries ideBrowserEnabled — the other six Companion fields stay", async () => {
      const payload = await executeExtensionQuery(
        { workspace: companionWorkspace(true) as never },
        { action: "companion.status" },
      );
      expect(payload).not.toHaveProperty("ideBrowserEnabled");
      expect(payload).toEqual(expect.objectContaining({
        tabTools: false,
        allowedHosts: [],
        paired: false,
        baseUrl: "http://127.0.0.1:1",
        engineLabel: "ide-browser-uncouple",
        devices: [],
      }));
    });
  });

  describe("shell collect helper — companion.status unavailable still matches the gate", () => {
    it("uses the dedicated query when companion.status throws", async () => {
      const seen: string[] = [];
      const ideBrowser = await readIdeBrowserEnabled({
        query: async (input) => {
          seen.push(input.action);
          if (input.action === "companion.status") throw new Error("companion.status unavailable");
          if (input.action === "config.ideBrowser.enabled") return { enabled: true };
          throw new Error(`unexpected query ${input.action}`);
        },
        shellEnabled: false,
      });
      expect(ideBrowser).toEqual({ enabled: true });
      expect(seen).toEqual(["config.ideBrowser.enabled"]);
    });

    it("on stays on and off stays off from the dedicated query", async () => {
      for (const enabled of [true, false]) {
        const ideBrowser = await readIdeBrowserEnabled({
          query: async () => ({ enabled }),
          shellEnabled: !enabled,
        });
        expect(ideBrowser, `enabled=${enabled}`).toEqual({ enabled });
      }
    });

    it("old engine / query error: result matches the shell gate, not merely presence", async () => {
      for (const shellEnabled of [true, false]) {
        const ideBrowser = await readIdeBrowserEnabled({
          query: async () => {
            throw new Error("unknown action config.ideBrowser.enabled");
          },
          shellEnabled,
        });
        expect(ideBrowser, `shellEnabled=${shellEnabled}`).toEqual({ enabled: shellEnabled });
      }
    });
  });

  it("Control collect wires the helper and no longer reads st.ideBrowserEnabled", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "apps/vscode-extension/src/extension.ts"),
      "utf8",
    );
    const producer = fs.readFileSync(
      path.join(process.cwd(), "packages/engine/src/engine-service/extensionOperationService.ts"),
      "utf8",
    );
    expect(source).toContain("readIdeBrowserEnabled");
    expect(source).not.toContain("st.ideBrowserEnabled");
    expect(producer).not.toMatch(/ideBrowserEnabled:\s*workspace\.config/);
  });
});
