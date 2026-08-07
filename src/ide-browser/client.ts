/**
 * Engine-side client: discover shell HTTP bridge and call it.
 * Discovery files live under ~/.tachyon/ide-browser-instances/ (written by the VS Code shell).
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { IdeBrowserEnvelope, IdeBrowserInstanceFile } from "./protocol.js";
import {
  IDE_BROWSER_INSTANCE_FRESHNESS_MS,
  IDE_BROWSER_INSTANCE_HEADER,
  IDE_BROWSER_INSTANCES_DIR_NAME,
} from "./protocol.js";

/** Operator home even when a private runtime rewrites `$HOME` (Grok/Hermes GROK_HOME etc.). */
function operatorHomedir(): string {
  try {
    const u = os.userInfo().homedir;
    if (u) return u;
  } catch {
    /* fall through */
  }
  return os.homedir();
}

function instancesDir(): string {
  return path.join(operatorHomedir(), ".tachyon", IDE_BROWSER_INSTANCES_DIR_NAME);
}

function normalizeRoot(root: string): string {
  return path.resolve(root);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isCurrentInstance(raw: IdeBrowserInstanceFile, nowMs: number): boolean {
  if (raw.kind !== "tachyon-ide-browser" || raw.schemaVersion !== 2) return false;
  if (typeof raw.instanceId !== "string" || raw.instanceId.length < 16) return false;
  const heartbeatMs = Date.parse(raw.heartbeatAt);
  return Number.isFinite(Date.parse(raw.startedAt))
    && Number.isFinite(heartbeatMs)
    && nowMs - heartbeatMs >= 0
    && nowMs - heartbeatMs <= IDE_BROWSER_INSTANCE_FRESHNESS_MS
    && isPidAlive(raw.pid);
}

/**
 * Remove instance files whose owning shell pid is dead (or file is corrupt).
 * Returns how many files were deleted. Safe to call often — discovery and shell start both use it.
 */
export function sweepDeadIdeBrowserInstances(dir = instancesDir(), nowMs = Date.now()): number {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8")) as IdeBrowserInstanceFile;
      if (!isCurrentInstance(raw, nowMs)) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      try {
        fs.unlinkSync(full);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/**
 * List fresh hosts for one exact workspace, newest owner first.
 * Parent/child fallback is deliberately absent: a worktree and its parent are different authorities.
 */
export function findIdeBrowserInstances(
  workspaceRoot: string,
  dir = instancesDir(),
  nowMs = Date.now(),
): IdeBrowserInstanceFile[] {
  sweepDeadIdeBrowserInstances(dir, nowMs);
  if (!fs.existsSync(dir)) return [];
  const want = normalizeRoot(workspaceRoot);
  const matches: IdeBrowserInstanceFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as IdeBrowserInstanceFile;
      if (!isCurrentInstance(raw, nowMs)) continue;
      const root = normalizeRoot(raw.workspaceRoot);
      if (want === root) matches.push(raw);
    } catch {
      /* skip corrupt */
    }
  }
  return matches.sort((a, b) => {
    const byStart = Date.parse(b.startedAt) - Date.parse(a.startedAt);
    return byStart || b.instanceId.localeCompare(a.instanceId);
  });
}

export function findIdeBrowserInstance(
  workspaceRoot: string,
  dir = instancesDir(),
  nowMs = Date.now(),
): IdeBrowserInstanceFile | null {
  return findIdeBrowserInstances(workspaceRoot, dir, nowMs)[0] ?? null;
}

export function isIdeBrowserBridgeAvailable(workspaceRoot: string): boolean {
  return findIdeBrowserInstance(workspaceRoot) !== null;
}

export async function ideBrowserRequest(
  workspaceRoot: string,
  route: string,
  body?: Record<string, unknown>,
  timeoutMs = 45_000,
  discoveryDir = instancesDir(),
): Promise<IdeBrowserEnvelope> {
  const instances = findIdeBrowserInstances(workspaceRoot, discoveryDir);
  if (instances.length === 0) {
    return {
      ok: false,
      code: "bridge_offline",
      error:
        "IDE browser bridge offline. In VS Code: Tachyon: IDE Browser Bridge Start (Dev Host / Extension Development).",
    };
  }
  let lastFailure: IdeBrowserEnvelope | null = null;
  for (const inst of instances) {
    const attempted = await requestInstance(inst, route, body, timeoutMs);
    if (!attempted.retryDiscovery) return attempted.envelope;
    lastFailure = attempted.envelope;
  }
  return lastFailure ?? { ok: false, code: "bridge_offline", error: "IDE browser bridge offline." };
}

async function requestInstance(
  inst: IdeBrowserInstanceFile,
  route: string,
  body: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<{ envelope: IdeBrowserEnvelope; retryDiscovery: boolean }> {
  const method = body === undefined ? "GET" : "POST";
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: inst.port,
        path: route.startsWith("/") ? route : `/${route}`,
        method,
        headers: {
          "content-type": "application/json",
          "x-tachyon-ide-browser-token": inst.token,
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const responseInstanceId = res.headers[IDE_BROWSER_INSTANCE_HEADER];
          if (res.statusCode === 401 || responseInstanceId !== inst.instanceId) {
            resolve({
              envelope: { ok: false, code: "bridge_identity_mismatch", error: "IDE browser host identity changed during discovery." },
              retryDiscovery: true,
            });
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ envelope: JSON.parse(text) as IdeBrowserEnvelope, retryDiscovery: false });
          } catch {
            resolve({
              envelope: { ok: false, error: `Invalid JSON from bridge (HTTP ${res.statusCode}): ${text.slice(0, 200)}` },
              retryDiscovery: false,
            });
          }
        });
      },
    );
    req.on("error", (err) => {
      resolve({ envelope: { ok: false, code: "bridge_error", error: err.message }, retryDiscovery: true });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({
        envelope: { ok: false, code: "timeout", error: `IDE browser bridge timed out after ${timeoutMs}ms` },
        retryDiscovery: false,
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
