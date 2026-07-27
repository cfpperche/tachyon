import fs from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSoulProfile,
  deleteSoulProfile,
  disableSoulProfile,
  enableSoulProfile,
  importSoulProfileBytesTransaction,
  importSoulProfileTransaction,
  replaceSoulProfileBytesTransaction,
  adoptSoulProfile,
  reconcileProfileTransactions,
  refreshSoulProfileStatus,
  listDegradedTransactions,
  journalContainsPath,
  principalBlockedByProfileTransaction,
  profileTransactionsRoot,
  type ProfileTxConfigAccess,
  type ProfileTransactionJournal,
} from "../../src/agents/soulProfileTransactions.js";
import { agentSoulManifestPath, agentSoulPath, cleanupStaleSoulLaunchReservationsSync, SOUL_LAUNCH_RESERVATION_BOOT_ID, SoulError, soulLaunchReservationsDir, SOUL_MAX_BYTES, SOUL_MINIMAL_TEMPLATE, withSoulProfileAdmission } from "../../src/agents/soul.js";
import { agentStanzaCasToken, setAgentSoulEnablement } from "../../src/config/YamlConfigEditor.js";
import { asAgent, parseConfig } from "../../src/config/loadConfig.js";
import { makeTempDir } from "../helpers/tempDir.js";

async function workspace(yaml?: string) {
  const root = makeTempDir("tachyon-profile-tx-");
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
      return asAgent(parseConfig(current).config?.agents[name])?.soul === true;
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
    const sourceRoot = makeTempDir("tachyon-import-src-");
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

  it("imports bounded webview bytes without a source path and rejects oversized payloads", async () => {
    const imported = await workspace();
    const bytes = Buffer.from("Voice\r\nValues\n");
    const result = await importSoulProfileBytesTransaction(imported.root, "Ada", bytes, imported.access);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(agentSoulPath(imported.root, "Ada"))).toEqual(bytes);

    const oversized = await workspace();
    await expect(importSoulProfileBytesTransaction(
      oversized.root,
      "Ada",
      Buffer.alloc(SOUL_MAX_BYTES + 1, 1),
      oversized.access,
    )).rejects.toMatchObject({ code: "soul/too-many-bytes" });
    await expect(readFile(agentSoulPath(oversized.root, "Ada"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces confirmed bytes by digest while preserving profile identity and enablement", async () => {
    for (const enabled of [true, false]) {
      const { root, access } = await workspace();
      const created = await createSoulProfile(root, "Ada", access);
      if (!enabled) await disableSoulProfile(root, "Ada", access);
      const before = await readFile(agentSoulPath(root, "Ada"));
      const replacement = Buffer.from(`# Replacement\n\nSoul stays ${enabled ? "enabled" : "disabled"}.\n`);

      const result = await replaceSoulProfileBytesTransaction(
        root,
        "Ada",
        replacement,
        createHash("sha256").update(before).digest("hex"),
        access,
      );

      expect(result).toMatchObject({
        action: "replace",
        profileId: created.profileId,
        sha256: createHash("sha256").update(replacement).digest("hex"),
        status: {
          lifecycle: enabled ? "active" : "retained",
          soulEnabled: enabled,
        },
      });
      expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(replacement);
    }
  });

  it("rejects stale replacement confirmation and restores prior files after a later failure", async () => {
    const stale = await workspace();
    await createSoulProfile(stale.root, "Ada", stale.access);
    const stalePrior = await readFile(agentSoulPath(stale.root, "Ada"));
    await expect(replaceSoulProfileBytesTransaction(
      stale.root,
      "Ada",
      Buffer.from("Replacement\n"),
      "a".repeat(64),
      stale.access,
    )).rejects.toMatchObject({ code: "soul/digest-mismatch" });
    expect(await readFile(agentSoulPath(stale.root, "Ada"))).toEqual(stalePrior);
    expect(await listDegradedTransactions(stale.root, "Ada")).toEqual([]);

    const rollback = await workspace();
    await createSoulProfile(rollback.root, "Ada", rollback.access);
    const priorSoul = await readFile(agentSoulPath(rollback.root, "Ada"));
    const priorManifest = await readFile(agentSoulManifestPath(rollback.root, "Ada"));
    rollback.access.writeConfigText = () => { throw new Error("injected config failure after replacement"); };
    await expect(replaceSoulProfileBytesTransaction(
      rollback.root,
      "Ada",
      Buffer.from("Replacement that must roll back\n"),
      createHash("sha256").update(priorSoul).digest("hex"),
      rollback.access,
    )).rejects.toMatchObject({ code: "soul/io-error" });
    expect(await readFile(agentSoulPath(rollback.root, "Ada"))).toEqual(priorSoul);
    expect(await readFile(agentSoulManifestPath(rollback.root, "Ada"))).toEqual(priorManifest);
    expect(await listDegradedTransactions(rollback.root, "Ada")).toEqual([]);
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
    await adoptSoulProfile(root, "Ada", access, { expectedDigest: retained.sha256!, enable: true });
    await expect(enableSoulProfile(root, "Ada", access)).resolves.toMatchObject({ action: "enable" });
  });

  it("confirmed-delete backend removes only Soul files for created or imported profiles", async () => {
    for (const origin of ["created", "imported"] as const) {
      const { root, access, read } = await workspace();
      if (origin === "created") await createSoulProfile(root, "Ada", access);
      else await importSoulProfileBytesTransaction(root, "Ada", Buffer.from("Imported identity\n"), access);

      const profileDir = path.dirname(agentSoulPath(root, "Ada"));
      const unrelated = path.join(profileDir, "future-agent-config.json");
      await writeFile(unrelated, '{"keep":true}\n');

      await expect(deleteSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/profile-enabled" });
      expect(await readFile(agentSoulPath(root, "Ada"), "utf8")).toBeTruthy();

      await disableSoulProfile(root, "Ada", access);
      const deleted = await deleteSoulProfile(root, "Ada", access);
      expect(deleted).toMatchObject({ action: "delete", status: { lifecycle: "missing", soulEnabled: false } });
      await expect(readFile(agentSoulPath(root, "Ada"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(agentSoulManifestPath(root, "Ada"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(unrelated, "utf8")).toBe('{"keep":true}\n');
      expect(fs.existsSync(profileDir)).toBe(true);
      expect(await readdir(profileDir)).toEqual(["future-agent-config.json"]);
      expect(read()).not.toContain("soul:");
    }
  });

  it("restores both Soul files when permanent deletion fails before commit", async () => {
    const { root, access } = await workspace();
    await createSoulProfile(root, "Ada", access);
    await disableSoulProfile(root, "Ada", access);
    const priorSoul = await readFile(agentSoulPath(root, "Ada"));
    const priorManifest = await readFile(agentSoulManifestPath(root, "Ada"));
    access.writeConfigText = () => { throw new Error("injected config failure after file deletion"); };

    await expect(deleteSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/io-error" });
    expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(priorSoul);
    expect(await readFile(agentSoulManifestPath(root, "Ada"))).toEqual(priorManifest);
    expect(await listDegradedTransactions(root, "Ada")).toEqual([]);
  });

  it("rejects mutations while a launch reservation is active", async () => {
    const { root, access } = await workspace();
    const reservations = soulLaunchReservationsDir(root);
    await mkdir(reservations, { recursive: true, mode: 0o700 });
    const reservation = path.join(reservations, "ada--exec--123e4567-e89b-42d3-a456-426614174000.json");
    await writeFile(reservation, JSON.stringify({ principal: "Ada", profileId: "x", sha256: "a".repeat(64), ownerPid: process.pid, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID }), {
      mode: 0o600,
      flag: "wx",
    });
    await expect(createSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/io-error" });
    await unlink(reservation);
    await expect(createSoulProfile(root, "Ada", access)).resolves.toMatchObject({ action: "create" });
  });

  it("keeps tampered live reservations blocking and only reaps a same-boot dead owner during mutation", async () => {
    const tampered = [
      ["different-boot-live", JSON.stringify({ principal: "Ada", ownerPid: process.pid, ownerBootId: "prior-extension-host" })],
      ["different-boot-dead", JSON.stringify({ principal: "Ada", ownerPid: 2_147_483_647, ownerBootId: "prior-extension-host" })],
      ["malformed", "{tampered"],
    ] as const;
    for (const [label, raw] of tampered) {
      const { root, access } = await workspace();
      const reservations = soulLaunchReservationsDir(root);
      await mkdir(reservations, { recursive: true, mode: 0o700 });
      const reservation = path.join(reservations, `ada--${label}--123e4567-e89b-42d3-a456-426614174001.json`);
      await writeFile(reservation, raw, { mode: 0o600 });
      await expect(createSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/io-error" });
      expect(await readFile(reservation, "utf8")).toBe(raw);
    }

    const { root, access } = await workspace();
    const reservations = soulLaunchReservationsDir(root);
    await mkdir(reservations, { recursive: true, mode: 0o700 });
    const dead = path.join(reservations, "ada--same-boot-dead--123e4567-e89b-42d3-a456-426614174002.json");
    await writeFile(dead, JSON.stringify({ principal: "Ada", ownerPid: 2_147_483_647, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID }), { mode: 0o600 });
    await expect(createSoulProfile(root, "Ada", access)).resolves.toMatchObject({ action: "create" });
    await expect(readFile(dead)).rejects.toMatchObject({ code: "ENOENT" });
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
      priorManifestDigest: null,
      targetManifestDigest: null,
      priorManifestState: "missing" as const,
      targetManifestState: "active" as const,
      priorConfig: agentStanzaCasToken(await readFile(file, "utf8"), "Bea"),
      targetConfig: agentStanzaCasToken(await readFile(file, "utf8"), "Bea"),
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

  it("defers reconciliation while the shared admission is live and re-reads safely after release", async () => {
    const { root, access, file } = await workspace();
    const txid = "123e4567-e89b-42d3-a456-426614174010";
    const txDir = path.join(profileTransactionsRoot(root), txid);
    await mkdir(txDir, { recursive: true, mode: 0o700 });
    const token = agentStanzaCasToken(await readFile(file, "utf8"), "Ada");
    const journal: ProfileTransactionJournal = {
      schemaVersion: 1,
      txid,
      action: "enable",
      principal: "Ada",
      phase: "intent",
      priorSoulDigest: null,
      targetSoulDigest: null,
      priorManifestDigest: null,
      targetManifestDigest: null,
      priorManifestState: "missing",
      targetManifestState: "missing",
      priorConfig: token,
      targetConfig: token,
      expectedSoulEnabled: true,
      createdAt: new Date().toISOString(),
    };
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
    expect((await reconcileProfileTransactions(root, () => access)).reconciled).toContain(txid);
    await expect(readFile(path.join(txDir, "journal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back only the affected stanza and preserves an unrelated YAML edit made after publication", async () => {
    const { root, access, file } = await workspace("agents:\n  Ada:\n    cmd: codex\n  Bea:\n    cmd: claude\n");
    const normalWrite = access.writeConfigText;
    let inject = true;
    access.writeConfigText = (next) => {
      if (!inject) return normalWrite(next);
      inject = false;
      const withUnrelatedEdit = next.replace("    cmd: claude\n", "    cmd: claude\n    role: reviewer\n");
      normalWrite(withUnrelatedEdit);
      throw new Error("crash after target config publication");
    };

    await expect(createSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/io-error" });
    const restored = await readFile(file, "utf8");
    expect(restored).toContain("role: reviewer");
    expect(restored).not.toMatch(/Ada:[\s\S]*?soul: true/);
    await expect(readFile(agentSoulPath(root, "Ada"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listDegradedTransactions(root, "Ada")).toEqual([]);
  });

  it("preserves an externally changed affected stanza and latches degraded instead of overwriting it", async () => {
    const { root, access, file } = await workspace();
    const normalWrite = access.writeConfigText;
    let inject = true;
    access.writeConfigText = (next) => {
      if (!inject) return normalWrite(next);
      inject = false;
      normalWrite(next.replace("    cmd: codex\n", "    cmd: codex\n    role: reviewer\n"));
      throw new Error("affected stanza changed after publication");
    };

    await expect(createSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/profile-transaction-degraded" });
    const current = await readFile(file, "utf8");
    expect(current).toContain("role: reviewer");
    expect(current).toContain("soul: true");
    expect(await listDegradedTransactions(root, "Ada")).toHaveLength(1);
  });

  it("requires a fresh valid digest for every adoption and preserves a valid stable profileId", async () => {
    const { root, access } = await workspace();
    await createSoulProfile(root, "Ada", access);
    const created = await refreshSoulProfileStatus(root, "Ada", access);
    await disableSoulProfile(root, "Ada", access);
    await expect(adoptSoulProfile(root, "Ada", access, { expectedDigest: "" })).rejects.toMatchObject({ code: "soul/digest-mismatch" });
    await expect(adoptSoulProfile(root, "Ada", access, { expectedDigest: "f".repeat(64) })).rejects.toMatchObject({ code: "soul/digest-mismatch" });
    const adopted = await adoptSoulProfile(root, "Ada", access, { expectedDigest: created.sha256! });
    expect(adopted.profileId).toBe(created.profileId);
  });

  it("keeps a same-boot live reservation blocking and clears stale reservation identities", async () => {
    const { root, access } = await workspace();
    const reservations = soulLaunchReservationsDir(root);
    await mkdir(reservations, { recursive: true, mode: 0o700 });
    const live = path.join(reservations, "ada--live--123e4567-e89b-42d3-a456-426614174011.json");
    await writeFile(live, JSON.stringify({ principal: "Ada", ownerPid: process.pid, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID }), { mode: 0o600 });
    await expect(createSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/io-error" });
    await unlink(live);
    const legacy = path.join(reservations, "ada--legacy--123e4567-e89b-42d3-a456-426614174012.json");
    const reusedPid = path.join(reservations, "ada--reused--123e4567-e89b-42d3-a456-426614174013.json");
    const dead = path.join(reservations, "ada--dead--123e4567-e89b-42d3-a456-426614174014.json");
    await writeFile(legacy, JSON.stringify({ principal: "Ada", ownerPid: process.pid }), { mode: 0o600 });
    await writeFile(reusedPid, JSON.stringify({ principal: "Ada", ownerPid: process.pid, ownerBootId: "prior-extension-host" }), { mode: 0o600 });
    await writeFile(dead, JSON.stringify({ principal: "Ada", ownerPid: 2_147_483_647, ownerBootId: SOUL_LAUNCH_RESERVATION_BOOT_ID }), { mode: 0o600 });
    expect(cleanupStaleSoulLaunchReservationsSync(root)).toEqual(expect.arrayContaining([
      path.basename(legacy),
      path.basename(reusedPid),
      path.basename(dead),
    ]));
    await expect(createSoulProfile(root, "Ada", access)).resolves.toMatchObject({ action: "create" });
    for (const stale of [legacy, reusedPid, dead]) await expect(readFile(stale)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converts corrupt and future-schema journals into durable fail-closed blockers for every principal", async () => {
    for (const [suffix, raw] of [["corrupt", "{no"], ["future", JSON.stringify({ schemaVersion: 99, txid: "future" })]] as const) {
      const { root, access } = await workspace();
      const txid = `123e4567-e89b-42d3-a456-4266141740${suffix === "corrupt" ? "13" : "14"}`;
      const txDir = path.join(profileTransactionsRoot(root), txid);
      await mkdir(txDir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(txDir, "journal.json"), raw, { mode: 0o600 });
      expect(await principalBlockedByProfileTransaction(root, "Ada")).toBe(true);
      const report = await reconcileProfileTransactions(root, () => access);
      expect(report.degraded).toContain(txid);
      const persisted = JSON.parse(await readFile(path.join(txDir, "journal.json"), "utf8")) as ProfileTransactionJournal;
      expect(persisted).toMatchObject({ principal: "*", phase: "degraded", degraded: true });
    }
  });

  it("recovers real crash boundaries phase-by-phase and refuses a profileId/manifest mismatch", async () => {
    const boundaries: Array<{
      phase: ProfileTransactionJournal["phase"];
      onDisk: "prior" | "published" | "target" | "compensating-mixed" | "degraded-partial";
      converges: "prior" | "target" | "blocked";
    }> = [
      { phase: "intent", onDisk: "prior", converges: "prior" },
      { phase: "staged", onDisk: "prior", converges: "prior" },
      { phase: "published", onDisk: "published", converges: "prior" },
      { phase: "config-written", onDisk: "target", converges: "target" },
      { phase: "committed", onDisk: "target", converges: "target" },
      { phase: "compensating", onDisk: "compensating-mixed", converges: "prior" },
      { phase: "degraded", onDisk: "degraded-partial", converges: "blocked" },
    ];
    for (const [index, boundary] of boundaries.entries()) {
      const { root, access, file } = await workspace();
      const txid = `123e4567-e89b-42d3-a456-4266141741${String(index).padStart(2, "0")}`;
      const txDir = path.join(profileTransactionsRoot(root), txid);
      await mkdir(txDir, { recursive: true, mode: 0o700 });
      const priorText = await readFile(file, "utf8");
      const targetText = setAgentSoulEnablement(priorText, "Ada", true).text;
      const soul = Buffer.from("target identity\n");
      const profileId = "123e4567-e89b-42d3-a456-426614174100";
      const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, profileId, owner: "Ada", state: "active" }, null, 2)}\n`);
      if (boundary.onDisk !== "prior") {
        await mkdir(path.dirname(agentSoulPath(root, "Ada")), { recursive: true, mode: 0o700 });
        await writeFile(agentSoulManifestPath(root, "Ada"), manifest, { mode: 0o600 });
      }
      if (boundary.onDisk === "published" || boundary.onDisk === "target" || boundary.onDisk === "degraded-partial") {
        await writeFile(agentSoulPath(root, "Ada"), soul, { mode: 0o600 });
      }
      if (boundary.onDisk === "target" || boundary.onDisk === "compensating-mixed") {
        await writeFile(file, targetText);
      }
      const journal: ProfileTransactionJournal = {
        schemaVersion: 1,
        txid,
        action: "create",
        principal: "Ada",
        phase: boundary.phase,
        profileId,
        targetProfileId: profileId,
        priorSoulDigest: null,
        targetSoulDigest: createHash("sha256").update(soul).digest("hex"),
        priorManifestDigest: null,
        targetManifestDigest: createHash("sha256").update(manifest).digest("hex"),
        priorManifestState: "missing",
        targetManifestState: "active",
        priorConfig: agentStanzaCasToken(priorText, "Ada"),
        targetConfig: agentStanzaCasToken(targetText, "Ada"),
        expectedSoulEnabled: true,
        createdAt: new Date().toISOString(),
        ...(boundary.phase === "degraded" ? { degraded: true, degradedCode: "profile-transaction-degraded" as const, degradedReason: "injected" } : {}),
      };
      await writeFile(path.join(txDir, "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
      const report = await reconcileProfileTransactions(root, () => access);
      if (boundary.converges === "blocked") {
        expect(report.degraded).toContain(txid);
        expect(fs.existsSync(path.join(txDir, "journal.json"))).toBe(true);
        expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(soul);
        expect(await readFile(agentSoulManifestPath(root, "Ada"))).toEqual(manifest);
        expect(await readFile(file, "utf8")).toBe(priorText);
        expect(await principalBlockedByProfileTransaction(root, "Ada")).toBe(true);
        continue;
      }
      expect(report.reconciled).toContain(txid);
      expect(fs.existsSync(txDir)).toBe(false);
      if (boundary.converges === "target") {
        expect(await readFile(agentSoulPath(root, "Ada"))).toEqual(soul);
        expect(await readFile(agentSoulManifestPath(root, "Ada"))).toEqual(manifest);
        expect(await readFile(file, "utf8")).toBe(targetText);
      } else {
        await expect(readFile(agentSoulPath(root, "Ada"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(agentSoulManifestPath(root, "Ada"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(file, "utf8")).toBe(priorText);
      }
    }

    const { root, access, file } = await workspace();
    const txid = "123e4567-e89b-42d3-a456-426614174199";
    const txDir = path.join(profileTransactionsRoot(root), txid);
    await mkdir(path.dirname(agentSoulPath(root, "Ada")), { recursive: true, mode: 0o700 });
    await mkdir(txDir, { recursive: true, mode: 0o700 });
    const priorText = await readFile(file, "utf8");
    const targetText = setAgentSoulEnablement(priorText, "Ada", true).text;
    await writeFile(file, targetText);
    const soul = Buffer.from("target identity\n");
    await writeFile(agentSoulPath(root, "Ada"), soul, { mode: 0o600 });
    const expectedManifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174198", owner: "Ada", state: "active" }, null, 2)}\n`);
    const tamperedManifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174197", owner: "Ada", state: "active" }, null, 2)}\n`);
    await writeFile(agentSoulManifestPath(root, "Ada"), tamperedManifest, { mode: 0o600 });
    const journal: ProfileTransactionJournal = {
      schemaVersion: 1,
      txid,
      action: "create",
      principal: "Ada",
      phase: "published",
      profileId: "123e4567-e89b-42d3-a456-426614174198",
      targetProfileId: "123e4567-e89b-42d3-a456-426614174198",
      priorSoulDigest: null,
      targetSoulDigest: createHash("sha256").update(soul).digest("hex"),
      priorManifestDigest: null,
      targetManifestDigest: createHash("sha256").update(expectedManifest).digest("hex"),
      priorManifestState: "missing",
      targetManifestState: "active",
      priorConfig: agentStanzaCasToken(priorText, "Ada"),
      targetConfig: agentStanzaCasToken(targetText, "Ada"),
      expectedSoulEnabled: true,
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(txDir, "journal.json"), `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    expect((await reconcileProfileTransactions(root, () => access)).degraded).toContain(txid);
    expect(await readFile(agentSoulManifestPath(root, "Ada"))).toEqual(tamperedManifest);
    expect(await listDegradedTransactions(root, "Ada")).toHaveLength(1);
  });

  it("fails closed when the transaction root is a symlink outside the workspace", async () => {
    const { root, access } = await workspace();
    const outside = makeTempDir("tachyon-profile-tx-outside-");
    await mkdir(path.join(root, ".tachyon"), { recursive: true });
    await symlink(outside, profileTransactionsRoot(root));
    await expect(createSoulProfile(root, "Ada", access)).rejects.toMatchObject({ code: "soul/outside-workspace" });
    expect(await readdir(outside)).toEqual([]);
    await rm(profileTransactionsRoot(root));
  });
});
