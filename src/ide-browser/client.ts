/**
 * Engine-side client: discover shell HTTP bridge and call it.
 * Discovery files live under ~/.tachyon/ide-browser-instances/ (written by the VS Code shell).
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { IdeBrowserEnvelope, IdeBrowserInstanceFile } from "./protocol.js";
import { IDE_BROWSER_INSTANCES_DIR_NAME } from "./protocol.js";

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

/**
 * Remove instance files whose owning shell pid is dead (or file is corrupt).
 * Returns how many files were deleted. Safe to call often — discovery and shell start both use it.
 */
export function sweepDeadIdeBrowserInstances(): number {
  const dir = instancesDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(full, "utf8")) as IdeBrowserInstanceFile;
      if (raw.kind !== "tachyon-ide-browser" || raw.schemaVersion !== 1 || !isPidAlive(raw.pid)) {
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

/** Find a live instance file whose workspaceRoot matches (or is a parent of) the given root. */
export function findIdeBrowserInstance(workspaceRoot: string): IdeBrowserInstanceFile | null {
  sweepDeadIdeBrowserInstances();
  const dir = instancesDir();
  if (!fs.existsSync(dir)) return null;
  const want = normalizeRoot(workspaceRoot);
  let best: IdeBrowserInstanceFile | null = null;
  let bestLen = -1;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as IdeBrowserInstanceFile;
      if (raw.kind !== "tachyon-ide-browser" || raw.schemaVersion !== 1) continue;
      if (!isPidAlive(raw.pid)) continue;
      const root = normalizeRoot(raw.workspaceRoot);
      if (want === root || want.startsWith(root + path.sep) || root.startsWith(want + path.sep)) {
        if (root.length > bestLen) {
          best = raw;
          bestLen = root.length;
        }
      }
    } catch {
      /* skip corrupt */
    }
  }
  return best;
}

export function isIdeBrowserBridgeAvailable(workspaceRoot: string): boolean {
  return findIdeBrowserInstance(workspaceRoot) !== null;
}

export async function ideBrowserRequest(
  workspaceRoot: string,
  route: string,
  body?: Record<string, unknown>,
  timeoutMs = 45_000,
): Promise<IdeBrowserEnvelope> {
  const inst = findIdeBrowserInstance(workspaceRoot);
  if (!inst) {
    return {
      ok: false,
      code: "bridge_offline",
      error:
        "IDE browser bridge offline. In VS Code: Tachyon: IDE Browser Bridge Start (Dev Host / Extension Development).",
    };
  }
  const method = body === undefined ? "GET" : "POST";
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise<IdeBrowserEnvelope>((resolve) => {
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
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text) as IdeBrowserEnvelope);
          } catch {
            resolve({ ok: false, error: `Invalid JSON from bridge (HTTP ${res.statusCode}): ${text.slice(0, 200)}` });
          }
        });
      },
    );
    req.on("error", (err) => {
      resolve({ ok: false, code: "bridge_error", error: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, code: "timeout", error: `IDE browser bridge timed out after ${timeoutMs}ms` });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
