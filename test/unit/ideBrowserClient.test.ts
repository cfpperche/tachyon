import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IDE_BROWSER_INSTANCE_FRESHNESS_MS,
  IDE_BROWSER_INSTANCE_HEADER,
  IDE_BROWSER_INSTANCES_DIR_NAME,
  type IdeBrowserInstanceFile,
} from "@tachyon/engine/ide-browser/protocol.js";
import {
  findIdeBrowserInstances,
  ideBrowserRequest,
  isIdeBrowserBridgeAvailable,
} from "@tachyon/engine/ide-browser/client.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-ide-browser-client-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function instance(overrides: Partial<IdeBrowserInstanceFile> = {}): IdeBrowserInstanceFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    kind: "tachyon-ide-browser",
    instanceId: "00000000-0000-4000-8000-000000000001",
    workspaceRoot: "/workspace/alpha",
    port: 49152,
    token: "token",
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

function writeInstance(dir: string, name: string, body: IdeBrowserInstanceFile): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body));
}

async function listen(
  handler: http.RequestListener,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const close = async (): Promise<void> => await new Promise((resolve) => server.close(() => resolve()));
  cleanup.push(close);
  return { port: address.port, close };
}

async function unusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("ide-browser protocol", () => {
  it("instances dir name is stable", () => {
    expect(IDE_BROWSER_INSTANCES_DIR_NAME).toBe("ide-browser-instances");
  });

  it("reports unavailable when no instance files", () => {
    // Unlikely a real instance points at this synthetic root
    expect(isIdeBrowserBridgeAvailable("/tmp/tachyon-no-such-workspace-ide-browser")).toBe(false);
  });

  it("arbitrates concurrent windows by newest start, with instance id as a stable tie-break", () => {
    const dir = tempDir();
    const older = instance({
      instanceId: "00000000-0000-4000-8000-000000000001",
      startedAt: "2026-08-07T10:00:00.000Z",
      heartbeatAt: "2026-08-07T10:00:10.000Z",
    });
    const newerA = instance({
      instanceId: "00000000-0000-4000-8000-000000000002",
      startedAt: "2026-08-07T10:00:05.000Z",
      heartbeatAt: "2026-08-07T10:00:10.000Z",
    });
    const newerB = instance({
      instanceId: "00000000-0000-4000-8000-000000000003",
      startedAt: newerA.startedAt,
      heartbeatAt: newerA.heartbeatAt,
    });
    writeInstance(dir, "z-directory-order-must-not-win", older);
    writeInstance(dir, "a", newerA);
    writeInstance(dir, "b", newerB);

    expect(findIdeBrowserInstances(older.workspaceRoot, dir, Date.parse(older.heartbeatAt)))
      .toEqual([newerB, newerA, older]);
  });

  it("keeps multi-root ownership exact and never crosses a parent/child boundary", () => {
    const dir = tempDir();
    const parent = instance({ workspaceRoot: "/workspace" });
    const alpha = instance({
      instanceId: "00000000-0000-4000-8000-000000000002",
      workspaceRoot: "/workspace/alpha",
    });
    const beta = instance({
      instanceId: "00000000-0000-4000-8000-000000000003",
      workspaceRoot: "/workspace/beta",
    });
    writeInstance(dir, "parent", parent);
    writeInstance(dir, "alpha", alpha);
    writeInstance(dir, "beta", beta);

    expect(findIdeBrowserInstances(alpha.workspaceRoot, dir).map((row) => row.instanceId)).toEqual([alpha.instanceId]);
    expect(findIdeBrowserInstances(beta.workspaceRoot, dir).map((row) => row.instanceId)).toEqual([beta.instanceId]);
    expect(findIdeBrowserInstances("/workspace/alpha/child", dir)).toEqual([]);
  });

  it("expires a stale credential even when its pid has been reused by a live process", () => {
    const dir = tempDir();
    const now = Date.now();
    const stale = instance({ heartbeatAt: new Date(now - IDE_BROWSER_INSTANCE_FRESHNESS_MS - 1).toISOString() });
    writeInstance(dir, "stale-live-pid", stale);

    expect(findIdeBrowserInstances(stale.workspaceRoot, dir, now)).toEqual([]);
    expect(fs.existsSync(path.join(dir, "stale-live-pid.json"))).toBe(false);
  });

  it("retries the surviving same-root window after the selected host fails identity validation", async () => {
    const dir = tempDir();
    const olderId = "00000000-0000-4000-8000-000000000001";
    const newerId = "00000000-0000-4000-8000-000000000002";
    const olderServer = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", [IDE_BROWSER_INSTANCE_HEADER]: olderId });
      res.end(JSON.stringify({ ok: true, data: { owner: "older-survivor" } }));
    });
    const wrongIdentityServer = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", [IDE_BROWSER_INSTANCE_HEADER]: "foreign-instance" });
      res.end(JSON.stringify({ ok: true, data: { owner: "wrong" } }));
    });
    const now = Date.now();
    writeInstance(dir, "older", instance({
      instanceId: olderId,
      port: olderServer.port,
      startedAt: new Date(now - 1_000).toISOString(),
    }));
    writeInstance(dir, "newer", instance({
      instanceId: newerId,
      port: wrongIdentityServer.port,
      startedAt: new Date(now).toISOString(),
    }));

    await expect(ideBrowserRequest("/workspace/alpha", "/status", undefined, 1_000, dir))
      .resolves.toEqual({ ok: true, data: { owner: "older-survivor" } });
  });

  it("closes the discovery/connect TOCTOU by retrying after the selected window vanishes", async () => {
    const dir = tempDir();
    const olderId = "00000000-0000-4000-8000-000000000001";
    const newerId = "00000000-0000-4000-8000-000000000002";
    const olderServer = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", [IDE_BROWSER_INSTANCE_HEADER]: olderId });
      res.end(JSON.stringify({ ok: true, data: { owner: "older-survivor" } }));
    });
    const vanishedPort = await unusedPort();
    const now = Date.now();
    writeInstance(dir, "older", instance({
      instanceId: olderId,
      port: olderServer.port,
      startedAt: new Date(now - 1_000).toISOString(),
    }));
    writeInstance(dir, "newer-vanished", instance({
      instanceId: newerId,
      port: vanishedPort,
      startedAt: new Date(now).toISOString(),
    }));

    await expect(ideBrowserRequest("/workspace/alpha", "/status", undefined, 1_000, dir))
      .resolves.toEqual({ ok: true, data: { owner: "older-survivor" } });
  });
});
