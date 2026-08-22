import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DURABLE_STATE_MANIFEST,
  isSecretPath,
} from "@tachyon/engine/statesync/manifest.js";
import { FilesystemBackupAdapter } from "@tachyon/engine/statesync/adapter.js";
import {
  collectDurableFiles,
  listGenerationIds,
  readGenerationManifest,
  runBackup,
  runRestore,
} from "@tachyon/engine/statesync/backup.js";
import { StateBackupService, type StateBackupSettings } from "@tachyon/engine/statesync/service.js";

let workspace: string;
let dest: string;

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** A miniature workspace with every durable store populated AND the secret-bearing paths present. */
function seedWorkspace(root: string): void {
  write(root, ".tachyon/tasks/t-000001.json", JSON.stringify({ id: "t-000001", title: "a task" }));
  write(root, ".tachyon/tasks/t-000001.journal", "note\n");
  write(root, ".tachyon/tasks/details/t-000001.json", JSON.stringify({ schemaVersion: 1 }));
  write(root, ".tachyon/tasks/t-000002.json.tmp.123.abc", "torn atomic temp");
  write(root, ".tachyon/pins.json", JSON.stringify({ pins: [] }));
  write(root, ".tachyon/pins/p-1.json", "{}");
  write(root, ".tachyon/validations/v-1.json", "{}");
  write(root, ".tachyon/evidence/claude/e-1/record.json", "{}");
  write(root, ".tachyon/review/wt/c-1/record.json", "{}");
  write(root, ".tachyon/continuity/claude.md", "# continuity\n");
  write(root, ".tachyon/HANDOFF.md", "# handoff\n");
  write(root, ".tachyon/handoff-notes.jsonl", "{}\n");
  write(root, ".tachyon/studies/spike.md", "PASS\n");
  write(root, ".tachyon/runs/r-1.json", "{}");
  write(root, ".tachyon/agents/claude/agent.yml", "schemaVersion: 1\n");
  write(root, ".tachyon/agents/claude/scratch.log", "runtime noise, not identity");
  write(root, ".tachyon/settings.yml", "auth: true\n");
  write(root, ".tachyon/terminals/test.yml", "cmd: npm test\n");
  write(root, ".tachyon/schedules/nightly.yml", "every: 1h\nspawn: claude\n");
  // Secrets that must NEVER reach a backup.
  write(root, ".tachyon/harness/claude/.credentials.json", "{\"token\":\"SECRET\"}");
  write(root, ".tachyon/harness/claude/history.jsonl", "machine-local");
  write(root, ".tachyon/secrets/api.txt", "SECRET");
  write(root, ".tachyon/secrets.env", "KEY=SECRET");
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-backup-ws-"));
  dest = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-backup-dest-"));
  seedWorkspace(workspace);
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

describe("durable-state manifest", () => {
  it("no manifest entry reaches a secret path", () => {
    for (const entry of DURABLE_STATE_MANIFEST) expect(isSecretPath(entry.relPath)).toBe(false);
  });

  it("collects durable files only: no secrets, no atomic temps, no runtime noise", () => {
    const files = collectDurableFiles(workspace);
    expect(files).toContain(".tachyon/tasks/t-000001.json");
    expect(files).toContain(".tachyon/tasks/t-000001.journal");
    expect(files).toContain(".tachyon/tasks/details/t-000001.json");
    expect(files).toContain(".tachyon/continuity/claude.md");
    expect(files).toContain(".tachyon/agents/claude/agent.yml");
    expect(files).toContain(".tachyon/settings.yml");
    expect(files).toContain(".tachyon/terminals/test.yml");
    expect(files).toContain(".tachyon/schedules/nightly.yml");
    const flat = files.join("\n");
    expect(flat).not.toContain("credentials");
    expect(flat).not.toContain("secret");
    expect(flat).not.toContain(".tmp.");
    expect(flat).not.toContain("scratch.log");
    expect(flat).not.toContain("harness");
  });
});

describe("backup → destroy → restore (the 2026-08-21 incident, reversed)", () => {
  it("round-trips every durable byte and nothing else", async () => {
    const adapter = new FilesystemBackupAdapter(dest);
    const before = Object.fromEntries(
      collectDurableFiles(workspace).map((rel) => [
        rel,
        crypto.createHash("sha256").update(fs.readFileSync(path.join(workspace, rel))).digest("hex"),
      ]),
    );

    const stats = await runBackup(workspace, adapter);
    expect(stats.files).toBe(Object.keys(before).length);

    // No secret bytes anywhere in the destination.
    const destFlat = (await adapter.list("generations")).join("\n");
    expect(destFlat).not.toContain("credentials");
    expect(destFlat).not.toContain("secret");

    // rm -rf the workspace, then restore into a fresh directory.
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });
    const restored = await runRestore(workspace, adapter);
    expect(restored.generationId).toBe(stats.generationId);
    expect(restored.files).toBe(stats.files);

    const after = Object.fromEntries(
      collectDurableFiles(workspace).map((rel) => [
        rel,
        crypto.createHash("sha256").update(fs.readFileSync(path.join(workspace, rel))).digest("hex"),
      ]),
    );
    expect(after).toEqual(before);
  });

  it("refuses to overwrite existing files without force, and overwrites with it", async () => {
    const adapter = new FilesystemBackupAdapter(dest);
    await runBackup(workspace, adapter);
    write(workspace, ".tachyon/tasks/t-000001.json", "{\"id\":\"t-000001\",\"title\":\"edited after backup\"}");
    await expect(runRestore(workspace, adapter)).rejects.toThrow(/would overwrite/);
    const restored = await runRestore(workspace, adapter, { force: true });
    expect(restored.files).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(workspace, ".tachyon/tasks/t-000001.json"), "utf8")).toContain("a task");
  });

  it("restores a NAMED generation for point-in-time recovery", async () => {
    const adapter = new FilesystemBackupAdapter(dest);
    const first = await runBackup(workspace, adapter);
    write(workspace, ".tachyon/tasks/t-000001.json", "{\"id\":\"t-000001\",\"title\":\"corrupted\"}");
    await runBackup(workspace, adapter);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-backup-restore-"));
    try {
      await runRestore(fresh, adapter, { generationId: first.generationId });
      expect(fs.readFileSync(path.join(fresh, ".tachyon/tasks/t-000001.json"), "utf8")).toContain("a task");
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("prunes old generations but keeps the newest N", async () => {
    const adapter = new FilesystemBackupAdapter(dest);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await runBackup(workspace, adapter, { keepGenerations: 2 })).generationId);
    const remaining = await listGenerationIds(adapter);
    expect(remaining).toEqual(ids.slice(-2).sort());
    // The pruned generations' files are gone too, not just their manifests.
    expect(await adapter.list(`generations/${ids[0]}`)).toEqual([]);
    // Latest still resolves to a complete, restorable generation.
    const manifest = await readGenerationManifest(adapter);
    expect(manifest?.id).toBe(ids[3]);
  });
});

describe("StateBackupService", () => {
  const everyMsOf = () => 1; // effectively "always due" — the tests drive tick() directly

  it("does nothing while settings are absent, and starts backing up when they appear (live opt-in)", async () => {
    let settings: StateBackupSettings | undefined;
    const service = new StateBackupService(workspace, () => settings, everyMsOf, 3600_000);
    await service.tick();
    expect(service.lastResult).toBeUndefined();
    expect(fs.readdirSync(dest)).toEqual([]);

    settings = { backend: "filesystem", path: dest };
    await service.tick();
    expect(service.lastResult?.files).toBeGreaterThan(0);
    expect(await listGenerationIds(new FilesystemBackupAdapter(dest))).toHaveLength(1);
    service.dispose();
  });

  it("respects the configured interval between passes", async () => {
    const settings: StateBackupSettings = { backend: "filesystem", path: dest };
    const service = new StateBackupService(workspace, () => settings, () => 3600_000, 3600_000);
    await service.tick();
    await service.tick();
    expect(await listGenerationIds(new FilesystemBackupAdapter(dest))).toHaveLength(1);
    service.dispose();
  });

  it("survives a broken destination and keeps the engine alive", async () => {
    const settings: StateBackupSettings = { backend: "filesystem", path: path.join(dest, "not-a-dir-file") };
    fs.writeFileSync(path.join(dest, "not-a-dir-file"), "a plain file where a directory must go");
    const service = new StateBackupService(workspace, () => settings, everyMsOf, 3600_000);
    await service.tick(); // must not throw
    expect(service.lastResult).toBeUndefined();
    service.dispose();
  });
});
