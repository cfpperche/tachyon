import fs from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adoptSoulProfile,
  createSoulProfile,
  disableSoulProfile,
  principalBlockedByProfileTransaction,
  profileTransactionsRoot,
  reconcileProfileTransactions,
  type ProfileTransactionJournal,
  type ProfileTxConfigAccess,
} from "../../src/agents/soulProfileTransactions.js";
import { agentSoulManifestPath, agentSoulPath, cleanupStaleSoulLaunchReservationsSync, SOUL_LAUNCH_RESERVATION_BOOT_ID, soulLaunchReservationsDir, withSoulProfileAdmission } from "../../src/agents/soul.js";
import { createHash } from "node:crypto";
import { agentStanzaCasToken } from "../../src/config/YamlConfigEditor.js";
import { asAgent, parseConfig } from "../../src/config/loadConfig.js";
import {
  AGENT_STUDIO_HOST_MESSAGE_NAMES,
  AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES,
  validateAgentStudioHostDomainMessage,
  validateAgentStudioInboundMessage,
  type SoulProfileStatusMessage,
} from "../../src/webview/agent-studio-shell/domain.js";
import { createSoulMessage, soulProfileStatusMessage } from "../../src/webview/agent-studio-shell/messages.js";
import { decodeStudioMessage } from "../../src/webview/shared/studio/protocol.js";

describe("container-generated delegation behavior", () => {
  it("spec 377 T15A transaction recovery and Studio trust closure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachyon-t15a-corrections-"));
    const configPath = path.join(root, "tachyon.yml");
    await writeFile(configPath, "agents:\n  Ada:\n    cmd: codex\n");
    const access: ProfileTxConfigAccess = {
      configPath,
      readConfigText: () => fs.readFileSync(configPath, "utf8"),
      writeConfigText: (text) => {
        const parsed = parseConfig(text);
        if (parsed.errors.length) throw new Error(parsed.errors[0]);
        fs.writeFileSync(configPath, text.endsWith("\n") ? text : `${text}\n`);
        return text;
      },
      isSoulEnabled: (name) => asAgent(parseConfig(fs.readFileSync(configPath, "utf8")).config?.agents[name])?.soul === true,
    };

    const reservations = soulLaunchReservationsDir(root);
    await mkdir(reservations, { recursive: true, mode: 0o700 });
    const legacyReservation = path.join(reservations, "ada--legacy--123e4567-e89b-42d3-a456-426614174371.json");
    const reusedPidReservation = path.join(reservations, "ada--reused--123e4567-e89b-42d3-a456-426614174372.json");
    const liveReservation = path.join(reservations, "ada--live--123e4567-e89b-42d3-a456-426614174373.json");
    await writeFile(legacyReservation, JSON.stringify({ principal: "Ada", ownerPid: process.pid }), { mode: 0o600 });
    await writeFile(reusedPidReservation, JSON.stringify({ principal: "Ada", ownerPid: process.pid, ownerBootId: "prior-extension-host" }), { mode: 0o600 });
    await writeFile(liveReservation, JSON.stringify({ principal: "Ada", ownerPid: process.pid, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID }), { mode: 0o600 });
    expect(cleanupStaleSoulLaunchReservationsSync(root)).toEqual(expect.arrayContaining([
      path.basename(legacyReservation),
      path.basename(reusedPidReservation),
    ]));
    expect(fs.existsSync(liveReservation)).toBe(true);
    fs.unlinkSync(liveReservation);

    const created = await createSoulProfile(root, "Ada", access);
    const stableProfileId = created.profileId;
    const stableDigest = created.sha256!;
    await disableSoulProfile(root, "Ada", access);
    await expect(adoptSoulProfile(root, "Ada", access, { expectedDigest: "" })).rejects.toMatchObject({ code: "soul/digest-mismatch" });
    await expect(adoptSoulProfile(root, "Ada", access, { expectedDigest: "f".repeat(64) })).rejects.toMatchObject({ code: "soul/digest-mismatch" });
    await expect(adoptSoulProfile(root, "Ada", access, { expectedDigest: stableDigest })).resolves.toMatchObject({ profileId: stableProfileId });

    const txid = "123e4567-e89b-42d3-a456-426614174377";
    const txDir = path.join(profileTransactionsRoot(root), txid);
    await mkdir(txDir, { recursive: true, mode: 0o700 });
    const currentSoul = await readFile(agentSoulPath(root, "Ada"));
    const currentManifest = await readFile(agentSoulManifestPath(root, "Ada"));
    const manifestDigest = createHash("sha256").update(currentManifest).digest("hex");
    const currentConfig = access.readConfigText();
    const token = agentStanzaCasToken(currentConfig, "Ada");
    const journal: ProfileTransactionJournal = {
      schemaVersion: 1,
      txid,
      action: "enable",
      principal: "Ada",
      phase: "intent",
      profileId: stableProfileId,
      priorProfileId: stableProfileId,
      targetProfileId: stableProfileId,
      priorSoulDigest: stableDigest,
      targetSoulDigest: stableDigest,
      priorManifestDigest: manifestDigest,
      targetManifestDigest: manifestDigest,
      priorManifestState: "active",
      targetManifestState: "active",
      priorConfig: token,
      targetConfig: token,
      expectedSoulEnabled: true,
      createdAt: new Date().toISOString(),
    };
    // This deliberately cannot prove the manifest tuple; the important race assertion is that a live
    // admission causes reconciliation to defer without touching the in-flight directory at all.
    await writeFile(path.join(txDir, "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = withSoulProfileAdmission(root, "Ada", async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    expect(await reconcileProfileTransactions(root, () => access)).toEqual({ reconciled: [], degraded: [] });
    expect(await readFile(path.join(txDir, "journal.json"), "utf8")).toContain('"phase":"intent"');
    release();
    await held;
    expect(currentSoul.length).toBeGreaterThan(0);

    await writeFile(path.join(txDir, "journal.json"), "{corrupt", { mode: 0o600 });
    expect(await principalBlockedByProfileTransaction(root, "Ada")).toBe(true);
    expect((await reconcileProfileTransactions(root, () => access)).degraded).toContain(txid);

    const inbound = createSoulMessage("Ada");
    expect(decodeStudioMessage(inbound, AGENT_STUDIO_WEBVIEW_MESSAGE_NAMES).ok).toBe(true);
    expect(decodeStudioMessage(inbound, AGENT_STUDIO_HOST_MESSAGE_NAMES).ok).toBe(false);
    expect(validateAgentStudioInboundMessage({ ...inbound, agent: "Bea" })).toEqual({ type: "createSoul", agent: "Bea" });
    expect(validateAgentStudioInboundMessage({ ...inbound, agent: "../Ada" })).toBeUndefined();
    const outbound = soulProfileStatusMessage({
      ...created.status,
      canonicalPath: "/private/absolute/SOUL.md",
      relativePath: ".tachyon/agents/Ada/SOUL.md",
    } as SoulProfileStatusMessage);
    expect(validateAgentStudioHostDomainMessage(outbound)).toBe(true);
    expect(JSON.stringify(outbound)).not.toContain("canonicalPath");
    expect(JSON.stringify(outbound)).not.toContain("/private/absolute");
  });
});
