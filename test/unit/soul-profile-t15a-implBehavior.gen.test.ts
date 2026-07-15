import fs from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adoptSoulProfile,
  createSoulProfile,
  disableSoulProfile,
  enableSoulProfile,
  importSoulProfileTransaction,
  listDegradedTransactions,
  reconcileProfileTransactions,
  refreshSoulProfileStatus,
  type ProfileTxConfigAccess,
} from "../../src/agents/soulProfileTransactions.js";
import {
  agentSoulPath,
  SOUL_MINIMAL_TEMPLATE,
  soulLaunchReservationsDir,
} from "../../src/agents/soul.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { agentStanzaCasToken } from "../../src/config/YamlConfigEditor.js";
import { AGENT_STUDIO_DOMAIN_MESSAGE_NAMES } from "../../src/webview/agent-studio-shell/domain.js";
import {
  createSoulMessage,
  importSoulMessage,
  soulProfileStatusMessage,
} from "../../src/webview/agent-studio-shell/messages.js";

function accessFor(file: string): ProfileTxConfigAccess {
  return {
    configPath: file,
    readConfigText: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined),
    writeConfigText: (text) => {
      const parsed = parseConfig(text);
      if (parsed.errors.length > 0) throw new Error(parsed.errors.join("; "));
      const out = text.endsWith("\n") ? text : `${text}\n`;
      fs.writeFileSync(file, out, "utf8");
      return out;
    },
    isSoulEnabled: (name) => {
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      return parseConfig(text).config?.agents[name]?.soul === true;
    },
  };
}

describe("container-generated delegation behavior", () => {
  it("spec 377 T15A canonical profile common-path actions", async () => {
    // Protocol names are explicit and typed for Agent Studio (UI layout is T16).
    expect(AGENT_STUDIO_DOMAIN_MESSAGE_NAMES).toEqual(expect.arrayContaining([
      "createSoul", "importSoul", "openSoul", "refreshSoul", "previewSoul",
      "adoptSoulProfile", "enableSoul", "disableSoul",
    ]));
    expect(createSoulMessage("Ada").type).toBe("createSoul");
    expect(importSoulMessage("Ada").type).toBe("importSoul");

    const root = await mkdtemp(path.join(tmpdir(), "tachyon-t15a-gate-"));
    const file = path.join(root, "tachyon.yml");
    await writeFile(file, "agents:\n  Ada:\n    cmd: codex\n  Bea:\n    cmd: claude\n    role: reviewer\n");
    const access = accessFor(file);

    // Create exclusively publishes the minimal template and enables soul.
    const created = await createSoulProfile(root, "Ada", access);
    expect(await readFile(agentSoulPath(root, "Ada"), "utf8")).toBe(SOUL_MINIMAL_TEMPLATE);
    expect(created.status.soulEnabled).toBe(true);
    expect(created.status.resolvable).toBe(true);

    // Unrelated stanza edits do not change Ada's CAS token.
    const adaToken = agentStanzaCasToken(access.readConfigText(), "Ada");
    access.writeConfigText(access.readConfigText()!.replace("role: reviewer", "role: tester"));
    expect(agentStanzaCasToken(access.readConfigText(), "Ada")).toEqual(adaToken);

    // Disable retains SOUL.md and marks retained.
    const bodyBefore = await readFile(agentSoulPath(root, "Ada"));
    await disableSoulProfile(root, "Ada", access);
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(bodyBefore);
    const retained = await refreshSoulProfileStatus(root, "Ada", access);
    expect(retained.lifecycle).toBe("retained");
    expect(retained.soulEnabled).toBe(false);

    // Enable requires active resolvable profile — retained needs adopt.
    await expect(enableSoulProfile(root, "Ada", access)).rejects.toMatchObject({
      code: "soul/profile-adoption-required",
    });

    // Digest-backed adopt/enable.
    const adopted = await adoptSoulProfile(root, "Ada", access, { expectedDigest: retained.sha256, enable: true });
    expect(adopted.status.lifecycle).toBe("active");
    expect(adopted.status.soulEnabled).toBe(true);

    // Import as exact copy for Bea; source path never surfaces in protocol/result/journal.
    const source = path.join(root, "outside-identity.md");
    const bytes = Buffer.from("Bea voice\r\nexact\n");
    await writeFile(source, bytes);
    const imported = await importSoulProfileTransaction(root, "Bea", source, access);
    expect(imported.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(JSON.stringify(imported)).not.toContain(source);
    expect(JSON.stringify(soulProfileStatusMessage({ ...imported.status, action: "import" }))).not.toContain(source);
    await writeFile(source, "mutated-source");
    expect(await readFile(agentSoulPath(root, "Bea"))).toEqual(bytes);

    // Self-selection of canonical path is adopt/enable without rewrite.
    await disableSoulProfile(root, "Bea", access);
    const self = await importSoulProfileTransaction(root, "Bea", agentSoulPath(root, "Bea"), access);
    expect(self.selfSelected).toBe(true);
    expect(await readFile(agentSoulPath(root, "Bea"))).toEqual(bytes);

    // Launch reservation blocks mutations.
    const reservations = soulLaunchReservationsDir(root);
    await mkdir(reservations, { recursive: true, mode: 0o700 });
    const reservation = path.join(reservations, "ada--x--123e4567-e89b-42d3-a456-426614174000.json");
    await writeFile(reservation, JSON.stringify({ principal: "Ada", sha256: "a".repeat(64) }), { mode: 0o600, flag: "wx" });
    await expect(disableSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/io-error" });
    await unlink(reservation);

    // Blocking degraded journal surfaces and blocks the principal.
    const txid = "123e4567-e89b-42d3-a456-426614174abc";
    const txDir = path.join(root, ".tachyon", "agent-profile-transactions", txid);
    await mkdir(txDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(txDir, "journal.json"), `${JSON.stringify({
      schemaVersion: 1,
      txid,
      action: "import",
      principal: "Ada",
      phase: "degraded",
      priorSoulDigest: created.sha256,
      targetSoulDigest: "c".repeat(64),
      priorManifestState: "active",
      targetManifestState: "active",
      priorConfig: agentStanzaCasToken(access.readConfigText(), "Ada"),
      expectedSoulEnabled: true,
      createdAt: new Date().toISOString(),
      degraded: true,
      degradedCode: "profile-transaction-degraded",
      degradedReason: "injected-for-gate",
    }, null, 2)}\n`, { mode: 0o600 });
    expect(await listDegradedTransactions(root, "Ada")).toHaveLength(1);
    expect((await refreshSoulProfileStatus(root, "Ada", access)).transactionDegraded).toBe(true);
    await expect(disableSoulProfile(root, "Ada", access)).rejects.toMatchObject({
      code: "soul/profile-transaction-degraded",
    });
    const report = await reconcileProfileTransactions(root, () => access);
    expect(report.degraded).toContain(txid);

    // Preview/refresh carry bounded status without import paths.
    const preview = await refreshSoulProfileStatus(root, "Bea", access);
    expect(preview.preview).toBeTruthy();
    expect(preview.relativePath).toBe(".tachyon/agents/Bea/SOUL.md");
    expect(JSON.stringify(preview)).not.toContain(source);
  });
});
