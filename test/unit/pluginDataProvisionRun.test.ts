import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { provisionData } from "../../src/plugins/toolProvisionRun.js";
import { gatherDataPlan } from "../../src/plugins/dataPlan.js";
import { emptyLockfile } from "../../src/plugins/lockfile.js";
import type { LoadedPlugin } from "../../src/plugins/engine.js";
import type { PluginManifest, DataDecl } from "../../src/plugins/manifest.js";
import { tlsKeypair } from "../helpers/tlsFixture.js";

const kp = tlsKeypair();
const MODEL = Buffer.from("ggml model weights — pretend 140MB");
const SHA = crypto.createHash("sha256").update(MODEL).digest("hex");

function pluginWithData(data: Record<string, DataDecl>): LoadedPlugin {
  const manifest = { name: "tr", version: "1.0.0", description: "d", runtimes: [], dependencies: [], blocks: {}, gitHooks: {}, tools: {}, data, externalTools: {} } as PluginManifest;
  return { dir: "/x", manifest, blocks: {}, rootRel: {}, skills: [], mcp: [], gitHooks: [] };
}

describe("provisionData — gating + empty (spec 284)", () => {
  it("fails closed without the data acknowledgement", async () => {
    const plan = await gatherDataPlan(pluginWithData({ model: { version: "base", single: { url: "https://h/m.bin", sha256: SHA } } }));
    const r = await provisionData("tr", "/tmp/x", plan, { existingLockfile: emptyLockfile() });
    expect(r.dataLocks).toEqual([]);
    expect(r.errors[0]).toMatch(/data acknowledgement/);
  });

  it("no-op on an empty plan", async () => {
    const r = await provisionData("tr", "/tmp/x", { items: [], unsupported: [] }, { dataConfirmed: true, existingLockfile: emptyLockfile() });
    expect(r).toEqual({ dataLocks: [], errors: [] });
  });
});

describe.skipIf(!kp)("provisionData — real https round-trip (spec 284)", () => {
  let server: https.Server;
  let base: string;
  let ws: string;

  beforeAll(async () => {
    server = https.createServer({ key: kp!.key, cert: kp!.cert }, (_req, res) => { res.writeHead(200); res.end(MODEL); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), "data-prov-")); });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("downloads → verifies → installs read-only, returns a DataLock", async () => {
    const plan = await gatherDataPlan(pluginWithData({ model: { version: "base", fileName: "ggml-base.bin", single: { url: `${base}/m.bin`, sha256: SHA } } }));
    const r = await provisionData("tr", ws, plan, { dataConfirmed: true, tlsCa: kp!.cert, existingLockfile: emptyLockfile() });
    expect(r.errors).toEqual([]);
    expect(r.dataLocks).toHaveLength(1);
    const lock = r.dataLocks[0];
    expect(lock).toMatchObject({ name: "model", resolvedPlatform: "any", contentSha256: SHA, fileName: "ggml-base.bin", version: "base" });
    expect(lock.installPath).toBe(`.tachyon/data/sha256/${SHA}/ggml-base.bin`);
    const abs = path.join(ws, lock.installPath);
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.statSync(abs).mode & 0o777).toBe(0o400);
    expect(crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")).toBe(SHA);
  });

  it("fails closed + rolls back when the artifact hash != the pin", async () => {
    const plan = await gatherDataPlan(pluginWithData({ model: { version: "base", single: { url: `${base}/m.bin`, sha256: "f".repeat(64) } } }));
    const r = await provisionData("tr", ws, plan, { dataConfirmed: true, tlsCa: kp!.cert, existingLockfile: emptyLockfile() });
    expect(r.dataLocks).toEqual([]);
    expect(r.errors[0]).toMatch(/checksum SHA_MISMATCH/);
    expect(fs.existsSync(path.join(ws, ".tachyon/data"))).toBe(false);
  });
});
