import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bridgeGenerationStateKey } from "@tachyon/bridge/clientRebind.js";
import { bridgeStateMigrationStorage } from "@tachyon/bridge/stateMigrationStorage.js";
import { bridgeTokenFileName } from "@tachyon/bridge/token.js";
import { DaemonStateStore } from "@tachyon/engine/engine-service/daemonStateStore.js";
import {
  applyEngineStateMigration,
  collectLegacyEngineStateMigration,
  ensureEngineStateMigration,
  type EngineStateMigrationV1,
} from "@tachyon/engine/engine-service/stateMigration.js";
import { PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY } from "@tachyon/engine/runtimeObservability/preferences.js";
import {
  CALLER_IDENTITY_HMAC_SECRET_KEY,
  authorityHeadsSecretKey,
  callerIdentityInstanceIdStateKey,
  callerIdentityRegistryStateKey,
  hostActionSessionEpochStateKey,
  workspaceVersionStateKey,
} from "@tachyon/engine/workspace/operationalStateKeys.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("one-time persistent engine state migration", () => {
  it("collects only the frozen operational allowlist from VS Code-owned storage", async () => {
    const root = temp();
    const legacy = path.join(root, "legacy");
    fs.mkdirSync(legacy, { mode: 0o700 });
    const hash = "a1b2c3d4";
    const instanceId = "bridge-instance-one";
    const hmac = "1".repeat(64);
    const registry = [{
      digestHex: "2".repeat(64),
      name: "codex",
      workspaceId: hash,
      instanceId,
      state: "live" as const,
      mintedAt: 100,
      lastSeenAt: 110,
      expiresAt: 200,
    }];
    const preferences = {
      schemaVersion: 1,
      providers: { codex: { accountScopeKey: `ps_${"3".repeat(16)}`, sources: ["cli"] } },
    };
    const state = new Map<string, unknown>([
      [callerIdentityInstanceIdStateKey(hash), instanceId],
      [callerIdentityRegistryStateKey(hash), registry],
      [hostActionSessionEpochStateKey(hash), 7],
      // Frozen profile keys/file names from the pre-inversion transport. Do not derive these through
      // bridgeStateMigrationStorage: this fixture proves the new composition still reads old disks.
      [`tachyon.bridgeClient.generation.${hash}.${instanceId}`, 4],
      [workspaceVersionStateKey(hash), "0.56.4"],
      [PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY, preferences],
      [`tachyon.terminals.open.v1.${hash}`, [{ name: "presentation-only" }]],
      ["unknown.extension.key", "must-not-cross"],
    ]);
    const secrets = new Map<string, string>([
      [CALLER_IDENTITY_HMAC_SECRET_KEY, hmac],
      [authorityHeadsSecretKey(hash), JSON.stringify({
        "canonical:d-one": { revision: 2, mac: "4".repeat(64) },
      })],
      ["unknown.secret", "must-not-cross"],
    ]);
    writeToken(legacy, `bridge-token-${hash}`, "5".repeat(64));
    writeToken(legacy, `bridge-external-token-${hash}`, "6".repeat(64));

    const migration = await collectLegacyEngineStateMigration(hash, {
      globalStorageRoot: legacy,
      getState: <T>(key: string) => state.get(key) as T | undefined,
      getSecret: async (key) => secrets.get(key),
    }, bridgeStateMigrationStorage);

    expect(migration).toEqual({
      schemaVersion: 1,
      workspaceHash: hash,
      state: {
        bridgeInstanceId: instanceId,
        callerRegistry: registry,
        hostActionSessionEpoch: 7,
        bridgeClientGeneration: 4,
        lastVersion: "0.56.4",
        providerObservationPreferences: preferences,
      },
      secrets: {
        callerIdentityHmacKey: hmac,
        authorityHeads: JSON.stringify({ "canonical:d-one": { revision: 2, mac: "4".repeat(64) } }),
      },
      tokens: { bridge: "5".repeat(64), external: "6".repeat(64) },
    });
    expect(JSON.stringify(migration)).not.toContain("presentation-only");
    expect(JSON.stringify(migration)).not.toContain("must-not-cross");
  });

  it("atomically imports fresh state once and ignores later ambient source changes", async () => {
    const root = temp();
    const storage = path.join(root, "engine");
    const migration = fixtureMigration();
    const first = await applyEngineStateMigration(storage, migration, bridgeStateMigrationStorage);
    expect(first.disposition).toBe("applied");
    expect(first.fields).toEqual(expect.arrayContaining([
      "state:imported",
      "secrets:imported",
      "tokens.bridge:imported",
      "tokens.external:imported",
    ]));

    const store = new DaemonStateStore(storage);
    expect(store.getState(callerIdentityInstanceIdStateKey(migration.workspaceHash))).toBe("bridge-one");
    expect(store.getState(hostActionSessionEpochStateKey(migration.workspaceHash))).toBe(9);
    expect(store.getState(bridgeGenerationStateKey(migration.workspaceHash, "bridge-one"))).toBe(3);
    expect(store.getSecret(CALLER_IDENTITY_HMAC_SECRET_KEY)).toBe("a".repeat(64));
    expect(readToken(storage, bridgeTokenFileName(migration.workspaceHash))).toBe("b".repeat(64));
    expect(fs.existsSync(path.join(storage, "legacy-state-migration-v1.pending.json"))).toBe(false);
    const completeBody = fs.readFileSync(path.join(storage, "legacy-state-migration-v1.complete.json"), "utf8");
    expect(completeBody).not.toContain("a".repeat(64));
    expect(completeBody).not.toContain("b".repeat(64));

    const changed: EngineStateMigrationV1 = {
      ...migration,
      state: { ...migration.state, lastVersion: "99.0.0" },
    };
    const replay = await applyEngineStateMigration(storage, changed, bridgeStateMigrationStorage);
    expect(replay.disposition).toBe("already-complete");
    expect((await ensureEngineStateMigration(storage, migration.workspaceHash, {
      storage: bridgeStateMigrationStorage,
      provide: async () => { throw new Error("legacy source must not be read after completion"); },
    })).disposition).toBe("already-complete");
    expect(new DaemonStateStore(storage).getState(workspaceVersionStateKey(migration.workspaceHash))).toBe("0.56.4");
  });

  it("replays the frozen pending envelope after interruption", async () => {
    const root = temp();
    const storage = path.join(root, "engine");
    const migration = fixtureMigration();
    await expect(applyEngineStateMigration(storage, migration, bridgeStateMigrationStorage, {
      beforeComplete: () => { throw new Error("simulated power loss"); },
    })).rejects.toThrow("simulated power loss");
    expect(fs.existsSync(path.join(storage, "legacy-state-migration-v1.pending.json"))).toBe(true);

    const changed: EngineStateMigrationV1 = {
      ...migration,
      state: { ...migration.state, lastVersion: "source-changed-after-crash" },
    };
    expect((await applyEngineStateMigration(storage, changed, bridgeStateMigrationStorage)).disposition).toBe("applied");
    expect(new DaemonStateStore(storage).getState(workspaceVersionStateKey(migration.workspaceHash))).toBe("0.56.4");
    expect(fs.existsSync(path.join(storage, "legacy-state-migration-v1.pending.json"))).toBe(false);
  });

  it("preserves an already-authoritative daemon store instead of mixing identities", async () => {
    const root = temp();
    const storage = path.join(root, "engine");
    const existing = new DaemonStateStore(storage);
    existing.setState("daemon-owned", { generation: 2 });

    const result = await applyEngineStateMigration(storage, fixtureMigration(), bridgeStateMigrationStorage);
    expect(result.fields).toEqual(expect.arrayContaining(["state:preserved", "secrets:preserved"]));
    const reopened = new DaemonStateStore(storage);
    expect(reopened.getState("daemon-owned")).toEqual({ generation: 2 });
    expect(reopened.getState(callerIdentityInstanceIdStateKey("a1b2c3d4"))).toBeUndefined();
    expect(reopened.getSecret(CALLER_IDENTITY_HMAC_SECRET_KEY)).toBeUndefined();
  });
});

function fixtureMigration(): EngineStateMigrationV1 {
  const hash = "a1b2c3d4";
  return {
    schemaVersion: 1,
    workspaceHash: hash,
    state: {
      bridgeInstanceId: "bridge-one",
      callerRegistry: [{
        digestHex: "d".repeat(64),
        name: "worker",
        workspaceId: hash,
        instanceId: "bridge-one",
        state: "live",
        mintedAt: 10,
        lastSeenAt: 11,
        expiresAt: 100,
      }],
      hostActionSessionEpoch: 9,
      bridgeClientGeneration: 3,
      lastVersion: "0.56.4",
      providerObservationPreferences: { schemaVersion: 1, providers: {} },
    },
    secrets: {
      callerIdentityHmacKey: "a".repeat(64),
      authorityHeads: JSON.stringify({ "canonical:d-one": { revision: 1, mac: "e".repeat(64) } }),
    },
    tokens: { bridge: "b".repeat(64), external: "c".repeat(64) },
  };
}

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-engine-migration-"));
  roots.push(root);
  return root;
}

function writeToken(root: string, fileName: string, token: string): void {
  fs.writeFileSync(path.join(root, fileName), `${token}\n`, { encoding: "utf8", mode: 0o600 });
}

function readToken(root: string, fileName: string): string {
  return fs.readFileSync(path.join(root, fileName), "utf8").trim();
}
