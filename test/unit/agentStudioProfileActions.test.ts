import { describe, expect, it } from "vitest";
import {
  AGENT_STUDIO_DOMAIN_MESSAGE_NAMES,
  type SoulProfileStatusMessage,
} from "../../src/webview/agent-studio-shell/domain.js";
import {
  adoptSoulProfileMessage,
  createSoulMessage,
  disableSoulMessage,
  enableSoulMessage,
  importSoulMessage,
  openSoulMessage,
  previewSoulMessage,
  refreshSoulMessage,
  soulProfileErrorMessage,
  soulProfileStatusMessage,
} from "../../src/webview/agent-studio-shell/messages.js";
import { assertNoDomainNameCollision, decodeStudioMessage } from "../../src/webview/shared/studio/protocol.js";
import { agentStanzaCasToken, setAgentSoulEnablement } from "../../src/config/YamlConfigEditor.js";

describe("Agent Studio soul profile protocol (T15A)", () => {
  it("registers explicit common-path domain message names without core collisions", () => {
    expect(AGENT_STUDIO_DOMAIN_MESSAGE_NAMES).toEqual(expect.arrayContaining([
      "createSoul",
      "importSoul",
      "openSoul",
      "refreshSoul",
      "previewSoul",
      "adoptSoulProfile",
      "enableSoul",
      "disableSoul",
      "soulProfileStatus",
      "soulProfileError",
      "browse",
      "cwd",
    ]));
    expect(() => assertNoDomainNameCollision(AGENT_STUDIO_DOMAIN_MESSAGE_NAMES)).not.toThrow();
    for (const name of AGENT_STUDIO_DOMAIN_MESSAGE_NAMES) {
      expect(decodeStudioMessage(
        { type: name, studioProtocolVersion: 1, agent: "Ada" },
        [...AGENT_STUDIO_DOMAIN_MESSAGE_NAMES],
      ).ok).toBe(true);
    }
  });

  it("builds typed webview→host and host→webview envelopes without source paths", () => {
    expect(createSoulMessage("Ada")).toMatchObject({ type: "createSoul", agent: "Ada" });
    expect(importSoulMessage("Ada")).toMatchObject({ type: "importSoul", agent: "Ada" });
    expect(openSoulMessage("Ada")).toMatchObject({ type: "openSoul", agent: "Ada" });
    expect(refreshSoulMessage("Ada")).toMatchObject({ type: "refreshSoul", agent: "Ada" });
    expect(previewSoulMessage("Ada")).toMatchObject({ type: "previewSoul", agent: "Ada" });
    expect(adoptSoulProfileMessage("Ada", "abc")).toMatchObject({ type: "adoptSoulProfile", agent: "Ada", expectedDigest: "abc" });
    expect(enableSoulMessage("Ada")).toMatchObject({ type: "enableSoul", agent: "Ada" });
    expect(disableSoulMessage("Ada")).toMatchObject({ type: "disableSoul", agent: "Ada" });

    const status: SoulProfileStatusMessage = {
      agent: "Ada",
      relativePath: ".tachyon/agents/Ada/SOUL.md",
      lifecycle: "active",
      profileId: "123e4567-e89b-42d3-a456-426614174000",
      sha256: "a".repeat(64),
      soulEnabled: true,
      resolvable: true,
      transactionDegraded: false,
      action: "import",
    };
    const envelope = soulProfileStatusMessage(status);
    expect(envelope).toMatchObject({ type: "soulProfileStatus", status });
    expect(JSON.stringify(envelope)).not.toContain("/home/");
    expect(JSON.stringify(envelope)).not.toContain("importSource");
    expect(soulProfileErrorMessage("Ada", "soul/profile-adoption-required", "needs adopt")).toMatchObject({
      type: "soulProfileError",
      agent: "Ada",
      code: "soul/profile-adoption-required",
    });
  });

  it("setAgentSoulEnablement only mutates the soul field of the target agent", () => {
    const base = "agents:\n  Ada:\n    cmd: codex\n    role: reviewer\n  Bea:\n    cmd: claude\n";
    const enabled = setAgentSoulEnablement(base, "Ada", true).text;
    expect(enabled).toMatch(/Ada:[\s\S]*soul: true/);
    expect(enabled).not.toMatch(/Bea:[\s\S]*soul:/);
    const disabled = setAgentSoulEnablement(enabled, "Ada", false).text;
    expect(disabled).not.toMatch(/Ada:[\s\S]*soul:/);
    expect(agentStanzaCasToken(base, "Bea")).toEqual(agentStanzaCasToken(enabled, "Bea"));
  });
});
