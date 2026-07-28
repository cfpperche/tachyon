import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DeliveryStore } from "../../src/delivery/store.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("SQLite DeliveryStore behavior", () => {
  it("persists one durable record rather than per-delivery JSON or lock state", async () => {
    const workspace = makeTempDir("tachyon-delivery-sqlite-");
    const store = new DeliveryStore(workspace);
    await store.create({
      id: "d-sqlite", workspaceId: "ws", createdBy: { kind: "system" },
      contract: { baseSha: "base", behaviorTest: "behavior", owns: [], taskRef: "refs/tachyon/task" },
      operationId: "create-sqlite",
    });

    expect(fs.existsSync(path.join(workspace, ".tachyon", "deliveries-v2.sqlite3"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".tachyon", "deliveries"))).toBe(false);
  });
});
