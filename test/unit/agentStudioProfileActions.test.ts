import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_STUDIO_DOMAIN_MESSAGE_NAMES,
  AGENT_STUDIO_HOST_MESSAGE_NAMES,
  AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES,
  SOUL_IMPORT_MAX_BYTES,
  isAllowedSoulImportFileName,
  validateAgentStudioHostDomainMessage,
  validateAgentStudioInboundMessage,
  type SoulProfileStatusMessage,
} from "../../src/webview/agent-studio-shell/domain.js";
import { SOUL_MAX_BYTES } from "../../src/agents/soul.js";
import {
  adoptSoulProfileMessage,
  createSoulMessage,
  deleteSoulProfileMessage,
  disableSoulMessage,
  enableSoulMessage,
  importSoulMessage,
  openSoulMessage,
  previewSoulMessage,
  replaceSoulMessage,
  refreshSoulMessage,
  soulProfileErrorMessage,
  soulProfileStatusMessage,
  forgetCanonicalProfileMessage,
  renameCanonicalProfileMessage,
  setCanonicalProfileEnabledMessage,
  exportCanonicalProfileBundleMessage,
  cloneCanonicalProfileBundleMessage,
  importCanonicalProfileBundleMessage,
} from "../../src/webview/agent-studio-shell/messages.js";
import { assertNoDomainNameCollision, decodeStudioMessage } from "../../src/webview/shared/studio/protocol.js";
import { openingPromptCapability, parseConfig } from "../../src/config/loadConfig.js";
import { agentStanzaCasToken, setAgentSoulEnablement } from "../../src/config/YamlConfigEditor.js";

describe("Agent Studio soul profile protocol (T15A)", () => {
  it("renders a state-focused Identity action surface before Role with secondary actions collapsed", () => {
    const source = fs.readFileSync(path.resolve("src/webview/agent-studio-shell/App.tsx"), "utf8");
    const pickerSource = fs.readFileSync(path.resolve("src/webview/shared/ui/kit/KitFilePicker.tsx"), "utf8");
    // t-610705 (Phase D, D1b) — the soul/evolution domain-message handler (and its safeMessage error
    // map) moved from AgentStudioPanel.ts (now types-only) to agentStudioDomain.ts.
    const hostSource = fs.readFileSync(path.resolve("src/cockpit/agentStudioDomain.ts"), "utf8");
    expect(source.indexOf("Identity (SOUL.md)")).toBeGreaterThan(-1);
    expect(source.indexOf("Role template")).toBeGreaterThan(source.indexOf("Identity (SOUL.md)"));
    for (const action of [
      "createSoulMessage(savedAgent)",
      "importSoulMessage(savedAgent, selection.contentBase64)",
      "replaceSoulMessage(savedAgent, soulReplacePending.contentBase64, soulStatus.sha256!)",
      "openSoulMessage(savedAgent)",
      "refreshSoulMessage(savedAgent)",
      "adoptSoulProfileMessage(savedAgent",
      "enableSoulMessage(savedAgent)",
      "disableSoulMessage(savedAgent)",
      "deleteSoulProfileMessage(savedAgent)",
    ]) expect(source).toContain(action);
    expect(source).toContain("showCreateOrImport &&");
    expect(source).toContain("profilePresent &&");
    expect(source).toContain("Replace existing identity?");
    expect(source).toContain("The selected source file will not be modified.");
    expect(source).toContain("Current SHA-256");
    expect(source).toContain("New SHA-256");
    expect(source).toContain("showEnable &&");
    expect(source).toContain("showDisable &&");
    expect(source).toContain("<KitDropdown>");
    expect(source).toContain('<KitDropdownContent align="start">');
    expect(source.indexOf("<KitDropdown>")).toBeLessThan(source.indexOf("refreshSoulMessage(savedAgent)", source.indexOf("<KitDropdown>")));
    expect(source).toContain(">Enable Soul</Button>");
    expect(source).toContain(">Disable Soul</Button>");
    expect(source).not.toContain("Adopt existing file");
    expect(source).not.toContain("Needs adoption");
    expect(source).toContain("Ready to enable");
    expect(source).toContain("enableRequiresOwnershipClaim");
    expect(source).not.toContain(">Preview</KitDropdownItem>");
    expect(source).toContain('aria-label="SOUL.md preview"');
    expect(hostSource).toContain("Refresh and choose Enable Soul.");
    expect(hostSource).not.toContain("explicit digest-backed adoption");
    expect(source).toContain("<KitFilePicker");
    expect(source).not.toContain('type="file"');
    expect(source).toContain("file.arrayBuffer()");
    expect(pickerSource).toContain('type="file"');
    expect(pickerSource).toContain("onDrop=");
    expect(pickerSource).toContain("<Button disabled={disabled}");
    expect(source).toContain("Delete this identity permanently?");
    expect(source).toContain("The agent directory and every other file inside it will remain.");
    expect(source).toContain('variant="danger"');
    expect(hostSource).not.toContain("Import SOUL.md (copied into the canonical profile)");
    expect(hostSource).toContain("ws.importSoulProfileBytes(agent, bytes)");
    expect(hostSource).toContain("ws.replaceSoulProfileBytes(agent, bytes, expectedDigest)");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('aria-label="SOUL.md preview"');
    expect(source).toContain("Profile recovery is required. Mutating actions are disabled.");
  });

  it("registers explicit common-path domain message names without core collisions", () => {
    expect(AGENT_STUDIO_DOMAIN_MESSAGE_NAMES).toEqual(expect.arrayContaining([
      "createSoul",
      "importSoul",
      "replaceSoul",
      "openSoul",
      "refreshSoul",
      "previewSoul",
      "adoptSoulProfile",
      "enableSoul",
      "disableSoul",
      "deleteSoulProfile",
      "soulProfileStatus",
      "soulProfileError",
      "browse",
      "cwd",
      "refreshCanonicalProfile",
      "setCanonicalProfileEnabled",
      "renameCanonicalProfile",
      "forgetCanonicalProfile",
      "canonicalProfileSnapshot",
      "canonicalProfileForgotten",
      "canonicalProfileError",
      "exportCanonicalProfileBundle",
      "cloneCanonicalProfileBundle",
      "importCanonicalProfileBundle",
      "canonicalProfileBundleExport",
      "canonicalProfileBundleCreated",
      "canonicalProfileBundleError",
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
    const contentBase64 = Buffer.from("# Identity\n", "utf8").toString("base64");
    expect(createSoulMessage("Ada")).toMatchObject({ type: "createSoul", agent: "Ada" });
    expect(importSoulMessage("Ada", contentBase64)).toMatchObject({ type: "importSoul", agent: "Ada", contentBase64 });
    expect(replaceSoulMessage("Ada", contentBase64, "a".repeat(64))).toMatchObject({
      type: "replaceSoul",
      agent: "Ada",
      contentBase64,
      expectedDigest: "a".repeat(64),
    });
    expect(openSoulMessage("Ada")).toMatchObject({ type: "openSoul", agent: "Ada" });
    expect(refreshSoulMessage("Ada")).toMatchObject({ type: "refreshSoul", agent: "Ada" });
    expect(previewSoulMessage("Ada")).toMatchObject({ type: "previewSoul", agent: "Ada" });
    expect(adoptSoulProfileMessage("Ada", "a".repeat(64))).toMatchObject({ type: "adoptSoulProfile", agent: "Ada", expectedDigest: "a".repeat(64) });
    expect(enableSoulMessage("Ada")).toMatchObject({ type: "enableSoul", agent: "Ada" });
    expect(disableSoulMessage("Ada")).toMatchObject({ type: "disableSoul", agent: "Ada" });
    expect(deleteSoulProfileMessage("Ada")).toMatchObject({ type: "deleteSoulProfile", agent: "Ada" });

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
    const envelope = soulProfileStatusMessage({ ...status, canonicalPath: "/home/private/workspace/.tachyon/agents/Ada/SOUL.md" } as SoulProfileStatusMessage);
    expect(envelope).toMatchObject({ type: "soulProfileStatus", status });
    expect(JSON.stringify(envelope)).not.toContain("/home/");
    expect(JSON.stringify(envelope)).not.toContain("importSource");
    expect(soulProfileErrorMessage("Ada", "soul/profile-adoption-required", "needs adopt")).toMatchObject({
      type: "soulProfileError",
      agent: "Ada",
      code: "soul/profile-adoption-required",
    });
  });

  it("splits directional allowlists and runtime-rejects tampered or cross-shape domain payloads", () => {
    const inbound = createSoulMessage("Ada");
    expect(decodeStudioMessage(inbound, AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES).ok).toBe(true);
    expect(decodeStudioMessage(inbound, AGENT_STUDIO_HOST_MESSAGE_NAMES).ok).toBe(false);
    expect(validateAgentStudioInboundMessage(inbound)).toEqual({ type: "createSoul", agent: "Ada" });
    expect(validateAgentStudioInboundMessage({ ...inbound, agent: "../Bea" })).toBeUndefined();
    expect(validateAgentStudioInboundMessage({ ...inbound, canonicalPath: "/tmp/escape" })).toBeUndefined();
    expect(validateAgentStudioInboundMessage(adoptSoulProfileMessage("Ada", "short"))).toBeUndefined();

    const imported = importSoulMessage("Ada", Buffer.from("# Ada\n").toString("base64"));
    expect(validateAgentStudioInboundMessage(imported)).toEqual({
      type: "importSoul",
      agent: "Ada",
      contentBase64: Buffer.from("# Ada\n").toString("base64"),
    });
    expect(validateAgentStudioInboundMessage({ ...imported, fileName: "../identity.md" })).toBeUndefined();
    expect(validateAgentStudioInboundMessage({ ...imported, contentBase64: "not base64" })).toBeUndefined();
    expect(validateAgentStudioInboundMessage({ ...imported, contentBase64: Buffer.alloc(SOUL_IMPORT_MAX_BYTES + 1, 1).toString("base64") })).toBeUndefined();
    const replacement = replaceSoulMessage("Ada", Buffer.from("# New Ada\n").toString("base64"), "b".repeat(64));
    expect(validateAgentStudioInboundMessage(replacement)).toEqual({
      type: "replaceSoul",
      agent: "Ada",
      contentBase64: Buffer.from("# New Ada\n").toString("base64"),
      expectedDigest: "b".repeat(64),
    });
    expect(validateAgentStudioInboundMessage({ ...replacement, expectedDigest: "stale" })).toBeUndefined();
    expect(validateAgentStudioInboundMessage({ ...replacement, confirmed: true })).toBeUndefined();
    expect(validateAgentStudioInboundMessage(deleteSoulProfileMessage("Ada"))).toEqual({ type: "deleteSoulProfile", agent: "Ada" });
    expect(validateAgentStudioInboundMessage({ ...deleteSoulProfileMessage("Ada"), confirmed: true })).toBeUndefined();

    const status = soulProfileStatusMessage({
      agent: "Ada",
      relativePath: ".tachyon/agents/Ada/SOUL.md",
      lifecycle: "active",
      profileId: "123e4567-e89b-42d3-a456-426614174000",
      sha256: "a".repeat(64),
      soulEnabled: true,
      resolvable: true,
      transactionDegraded: false,
    });
    expect(decodeStudioMessage(status, AGENT_STUDIO_HOST_MESSAGE_NAMES).ok).toBe(true);
    expect(validateAgentStudioHostDomainMessage(status)).toBe(true);
    expect(validateAgentStudioHostDomainMessage({ ...status, status: { ...status.status, relativePath: "/absolute/SOUL.md" } })).toBe(false);
    expect(decodeStudioMessage(status, AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES).ok).toBe(false);

    const revision = "a".repeat(64);
    const enabled = setCanonicalProfileEnabledMessage("Ada", revision, true);
    expect(validateAgentStudioInboundMessage(enabled)).toEqual({ type: "setCanonicalProfileEnabled", agent: "Ada", expectedRevision: revision, enabled: true });
    expect(validateAgentStudioInboundMessage({ ...enabled, editable: {} })).toBeUndefined();
    const rename = renameCanonicalProfileMessage("Ada", revision, "Bea");
    expect(validateAgentStudioInboundMessage(rename)).toEqual({ type: "renameCanonicalProfile", agent: "Ada", expectedRevision: revision, newName: "Bea" });
    expect(validateAgentStudioInboundMessage({ ...rename, newName: "../Bea" })).toBeUndefined();
    const forget = forgetCanonicalProfileMessage("Ada", revision, "Ada");
    expect(validateAgentStudioInboundMessage(forget)).toEqual({ type: "forgetCanonicalProfile", agent: "Ada", expectedRevision: revision, confirmation: "Ada" });
    expect(validateAgentStudioInboundMessage({ ...forget, expectedRevision: "stale" })).toBeUndefined();
    expect(validateAgentStudioInboundMessage(exportCanonicalProfileBundleMessage("Ada", revision))).toMatchObject({ type: "exportCanonicalProfileBundle", expectedRevision: revision });
    expect(validateAgentStudioInboundMessage(cloneCanonicalProfileBundleMessage("Ada", revision, "Bea"))).toMatchObject({ type: "cloneCanonicalProfileBundle", destinationAgentName: "Bea" });
    const portable = importCanonicalProfileBundleMessage("Ada", "Bea", Buffer.from("{}\n").toString("base64"));
    expect(validateAgentStudioInboundMessage(portable)).toMatchObject({ type: "importCanonicalProfileBundle", destinationAgentName: "Bea" });
    expect(validateAgentStudioInboundMessage({ ...portable, contentBase64: "not base64" })).toBeUndefined();
  });

  it("keeps lifecycle controls canonical-only, dirty-gated, and cancel-focused for rename and forget", () => {
    const source = fs.readFileSync(path.resolve("src/webview/agent-studio-shell/App.tsx"), "utf8");
    expect(source).toContain('canonical && mode === "edit"');
    expect(source).toContain("const canonicalLifecycleDisabled = !canonicalSnapshot || !!profileBusy || dirty || frozen || profileRetired");
    expect(source).toContain("renameCancelButtonRef.current?.focus()");
    expect(source).toContain("forgetCancelButtonRef.current?.focus()");
    expect(source).toContain("Type <strong>{canonicalSnapshot.agentName}</strong> to confirm.");
    expect(source).toContain("forgetValue !== canonicalSnapshot.agentName");
    expect(source).toContain("bundleCancelButtonRef.current?.focus()");
    expect(source).toContain("Creates a new disabled agent. Secrets, grants and workspace bindings must be authorized again.");
    expect(source).toContain('{canonical && <div class="hint">{profileLabels.canonicalTrustHelp}</div>}');
    expect(source).toContain('aria-labelledby="ash-profile-sources-title"');
    expect(source).toContain("canonicalSnapshot.provenance.authority.grants");
    expect(source).toContain("profileLabels.retryRefresh");
  });

  it("ships canonical profile labels in English and pt-BR", () => {
    const en = JSON.parse(fs.readFileSync(path.resolve("l10n/bundle.l10n.json"), "utf8")) as Record<string, string>;
    const pt = JSON.parse(fs.readFileSync(path.resolve("l10n/bundle.l10n.pt-br.json"), "utf8")) as Record<string, string>;
    expect(en["Profile sources and authority"]).toBe("Profile sources and authority");
    expect(pt["Profile sources and authority"]).toBe("Origens e autoridade do perfil");
    expect(pt["Only authored profile values are editable. Authority, learned state, and runtime projection are read-only."]).toContain("somente leitura");
    expect(pt["Refresh and retry"]).toBe("Atualizar e tentar novamente");
    const trustCopy = "Enabling or starting this canonical agent authorizes native folder trust only for the current workspace and effective working directory. General approvals, sandbox policy, and arbitrary hook trust stay unchanged.";
    expect(en[trustCopy]).toBe(trustCopy);
    expect(pt[trustCopy]).toContain("workspace atual");
  });

  it("keeps the browser import cap aligned with the authoritative soul byte cap", () => {
    expect(SOUL_IMPORT_MAX_BYTES).toBe(SOUL_MAX_BYTES);
    expect(isAllowedSoulImportFileName("identity.md")).toBe(true);
    expect(isAllowedSoulImportFileName("identity.markdown")).toBe(true);
    expect(isAllowedSoulImportFileName("identity.txt")).toBe(true);
    expect(isAllowedSoulImportFileName("identity.pdf")).toBe(false);
    expect(isAllowedSoulImportFileName("../identity.md")).toBe(false);
  });

  it("prepares one identity marker per dogfood runtime, and declares no agent inline", () => {
    // SDD 478 M7 — the fixture used to declare the four soul agents inline, which no workspace
    // loads any more; they are created in Agent Studio at dogfood time (opencode is not even an
    // attested runtime, so it cannot be declared at all). What the fixture still owns is the
    // per-runtime material the scenario needs: one identity marker each, and a roster that starts
    // no agent by itself.
    const fixture = path.resolve("test/fixtures/agent-soul-dogfood");
    const parsed = parseConfig(fs.readFileSync(path.join(fixture, "tachyon.yml"), "utf8"));
    expect(parsed.errors).toEqual([]);
    const expected = {
      "soul-claude": { runtime: "claude", channel: "startup-argument", marker: "SOUL-CLAUDE-OK" },
      "soul-codex": { runtime: "codex", channel: "startup-argument", marker: "SOUL-CODEX-OK" },
      "soul-grok": { runtime: "grok", channel: "startup-argument", marker: "SOUL-GROK-OK" },
      "soul-opencode": { runtime: "opencode", channel: "tui-prefill", marker: "SOUL-OPENCODE-OK" },
    } as const;
    expect(Object.values(parsed.config!.agents).some((entry) => entry.kind === "agent")).toBe(false);
    for (const target of Object.values(expected)) {
      expect(openingPromptCapability(target.runtime)).toEqual({ status: "prompt", runtime: target.runtime, channel: target.channel });
      expect(fs.readFileSync(path.join(fixture, `identity-${target.runtime}.md`), "utf8")).toContain(target.marker);
    }
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
