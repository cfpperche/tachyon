import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSoulProfile,
  disableSoulProfile,
  enableSoulProfile,
  importSoulProfileTransaction,
  adoptSoulProfile,
  reconcileProfileTransactions,
  refreshSoulProfileStatus,
  listDegradedTransactions,
  journalContainsPath,
  type ProfileTxConfigAccess,
} from "../../src/agents/soulProfileTransactions.js";
import { agentSoulPath, SoulError, soulLaunchReservationsDir, SOUL_MINIMAL_TEMPLATE } from "../../src/agents/soul.js";
import { agentStanzaCasToken, setAgentSoulEnablement } from "../../src/config/YamlConfigEditor.js";
import { parseConfig } from "../../src/config/loadConfig.js";

async function workspace(yaml?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "tachyon-profile-tx-"));
  const file = path.join(root, "tachyon.yml");
  const text = yaml ?? "agents:\n  Ada:\n    cmd: codex\n";
  await writeFile(file, text);
  const access: ProfileTxConfigAccess = {
    configPath: file,
    readConfigText: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined),
    writeConfigText: (next) => {
      const parsed = parseConfig(next);
      if (parsed.errors.length > 0) throw new Error(parsed.errors[0]);
      const out = next.endsWith("\n") ? next : `${next}\n`;
      fs.writeFileSync(file, out, "utf8");
      return out;
    },
    isSoulEnabled: (name) => {
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      return parseConfig(current).config?.agents[name]?.soul === true;
    },
  };
  return { root, file, access, read: () => fs.readFileSync(file, "utf8") };
}

describe("soul profile transactions (T15A)", () => {
  it("creates a minimal template, enables soul, and leaves no journal residue", async () => {
    const { root, access, read } = await workspace();
    const result = await createSoulProfile(root, "Ada", access);
    expect(result.action).toBe("create");
    expect(result.status.lifecycle).toBe("active");
    expect(result.status.soulEnabled).toBe(true);
    expect(await readFile(agentSoulPath(root, "Ada"), "utf8")).toBe(SOUL_MINIMAL_TEMPLATE);
    expect(read()).toContain("soul: true");
    expect(await readdir(path.join(root, ".tachyon", "agent-profile-transactions")).catch(() => [])).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/^[0-9a-f-]{36}$/i)]),
    );
  });

  it("imports exact bytes, never persists the source path, and rejects silent overwrite", async () => {
    const { root, access } = await workspace();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "tachyon-import-src-"));
    const source = path.join(sourceRoot, "identity.md");
    const bytes = Buffer.from("Voice\r\nValues\n");
    await writeFile(source, bytes);
    const result = await importSoulProfileTransaction(root, "Ada", source, access);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(bytes);
    expect(JSON.stringify(result)).not.toContain(source);
    await writeFile(source, "changed");
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(bytes);
    await expect(importSoulProfileTransaction(root, "Ada", source, access)).rejects.toMatchObject({
      code: "soul/profile-adoption-required",
    });
  });

  it("treats self-selection of the canonical path as digest-backed adopt/enable", async () => {
    const { root, access } = await workspace();
    const source = path.join(root, "seed.md");
    await writeFile(source, "Adopted identity\n");
    await importSoulProfileTransaction(root, "Ada", source, access);
    await disableSoulProfile(root, "Ada", access);
    const status = await refreshSoulProfileStatus(root, "Ada", access);
    expect(status.lifecycle).toBe("retained");
    expect(status.soulEnabled).toBe(false);
    const canonical = agentSoulPath(root, "Ada");
    const adopted = await importSoulProfileTransaction(root, "Ada", canonical, access);
    expect(adopted.selfSelected).toBe(true);
    expect(adopted.status.lifecycle).toBe("active");
    expect(adopted.status.soulEnabled).toBe(true);
    expect(await readFile(canonical, "utf8")).toBe("Adopted identity\n");
  });

  it("disable retains bytes and marks retained; enable requires resolvable active profile", async () => {
    const { root, access } = await workspace();
    await createSoulProfile(root, "Ada", access);
    const before = await readFile(agentSoulPath(root, "Ada"));
    await disableSoulProfile(root, "Ada", access);
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(before);
    const retained = await refreshSoulProfileStatus(root, "Ada", access);
    expect(retained.lifecycle).toBe("retained");
    expect(retained.soulEnabled).toBe(false);
    await expect(enableSoulProfile(root, "Ada", access)).rejects.toMatchObject({
      code: "soul/profile-adoption-required",
    });
    await adoptSoulProfile(root, "Ada", access, { expectedDigest: retained.sha256, enable: true });
    await expect(enableSoulProfile(root, "Ada", access)).resolves.toMatchObject({ action: "enable" });
  });

  it("rejects mutations while a launch reservation is active", async () => {
    const { root, access } = await workspace();
    const reservations = soulLaunchReservationsDir(root);
    await mkdir(reservations, { recursive: true, mode: 0o700 });
    const reservation = path.join(reservations, "ada--exec--123e4567-e89b-42d3-a456-426614174000.json");
    await writeFile(reservation, JSON.stringify({ principal: "Ada", profileId: "x", sha256: "a".repeat(64) }), {
      mode: 0o600,
      flag: "wx",
    });
    await expect(createSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/io-error" });
    await unlink(reservation);
    await expect(createSoulProfile(root, "Ada", access)).resolves.toMatchObject({ action: "create" });
  });

  it("CAS ignores unrelated agent stanzas and fails when the affected stanza drifts", async () => {
    const text = "agents:\n  Ada:\n    cmd: codex\n  Bea:\n    cmd: claude\n";
    const ada = agentStanzaCasToken(text, "Ada");
    const withBeaSoul = setAgentSoulEnablement(text, "Bea", true).text;
    expect(agentStanzaCasToken(withBeaSoul, "Ada")).toEqual(ada);
    const drifted = setAgentSoulEnablement(text, "Ada", true).text;
    expect(agentStanzaCasToken(drifted, "Ada").hash).not.toEqual(ada.hash);
  });

  it("surfaces a blocking profile-transaction-degraded journal on startup reconcile", async () => {
    const { root, access, file } = await workspace();
    await createSoulProfile(root, "Ada", access);
    const priorSoul = await readFile(agentSoulPath(root, "Ada"));
    const text = `${await readFile(file, "utf8")}  Bea:\n    cmd: codex\n`;
    await writeFile(file, text);
    const txRoot = path.join(root, ".tachyon", "agent-profile-transactions");
    const txid = "123e4567-e89b-42d3-a456-426614174099";
    const txDir = path.join(txRoot, txid);
    await mkdir(txDir, { recursive: true, mode: 0o700 });
    const journal = {
      schemaVersion: 1 as const,
      txid,
      action: "create" as const,
      principal: "Bea",
      phase: "degraded" as const,
      priorSoulDigest: null,
      targetSoulDigest: "b".repeat(64),
      priorManifestState: "missing" as const,
      targetManifestState: "active" as const,
      priorConfig: agentStanzaCasToken(await readFile(file, "utf8"), "Bea"),
      expectedSoulEnabled: true,
      createdAt: new Date().toISOString(),
      degraded: true,
      degradedCode: "profile-transaction-degraded" as const,
      degradedReason: "injected",
    };
    await writeFile(path.join(txDir, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    expect(journalContainsPath(journal, "/tmp/secret-import.md")).toBe(false);
    expect(await listDegradedTransactions(root, "Bea")).toHaveLength(1);
    expect((await refreshSoulProfileStatus(root, "Bea", access)).transactionDegraded).toBe(true);
    await expect(createSoulProfile(root, "Bea", access)).rejects.toMatchObject({
      code: "soul/profile-transaction-degraded",
    });
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(priorSoul);
    const report = await reconcileProfileTransactions(root, () => access);
    expect(report.degraded).toContain(txid);
  });

  it("rejects create for an undeclared agent", async () => {
    const { root, access } = await workspace("agents:\n  Only:\n    cmd: codex\n");
    await expect(createSoulProfile(root, "Ghost", access)).rejects.toBeInstanceOf(SoulError);
  });
});
