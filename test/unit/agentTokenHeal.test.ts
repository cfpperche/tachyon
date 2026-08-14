import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  CallerIdentityRegistry,
  type CallerScope,
} from "@tachyon/engine/bridge/callerIdentity.js";
import {
  findAgentNameForBridgeToken,
  healUnknownBearerFromProc,
  readProcEnvVar,
  type ProcFs,
} from "@tachyon/engine/bridge/agentTokenHeal.js";

const SCOPE: CallerScope = { workspaceId: "ws", instanceId: "inst" };
const KEY = crypto.randomBytes(32);

function fakeProc(files: Record<string, string>): ProcFs {
  return {
    readdirSync(dir: string) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const seg = rest.split("/")[0];
        if (seg) names.add(seg);
      }
      // also include pid dirs from top-level /proc keys
      if (dir === "/proc" || dir === "/proc/") {
        for (const p of Object.keys(files)) {
          const m = p.match(/^\/proc\/(\d+)\//);
          if (m) names.add(m[1]!);
        }
      }
      return [...names];
    },
    readFileSync(file: string) {
      if (file in files) return files[file]!;
      throw new Error(`ENOENT ${file}`);
    },
  };
}

describe("agentTokenHeal", () => {
  it("readProcEnvVar parses null-separated environ", () => {
    const proc = fakeProc({
      "/proc/42/environ": "FOO=1\0TACHYON_AGENT_BRIDGE_TOKEN=aabb\0TACHYON_AGENT_NAME=grok\0",
    });
    expect(readProcEnvVar(42, "TACHYON_AGENT_NAME", "/proc", proc)).toBe("grok");
    expect(readProcEnvVar(42, "TACHYON_AGENT_BRIDGE_TOKEN", "/proc", proc)).toBe("aabb");
    expect(readProcEnvVar(42, "MISSING", "/proc", proc)).toBeUndefined();
  });

  it("findAgentNameForBridgeToken matches full /proc scan", () => {
    const token = "ab".repeat(32);
    const proc = fakeProc({
      "/proc/1/stat": "1 (init) S 0",
      "/proc/1/environ": "PATH=/\0",
      "/proc/99/stat": "99 (grok) S 1",
      "/proc/99/environ": `TACHYON_AGENT_NAME=grok\0TACHYON_AGENT_BRIDGE_TOKEN=${token}\0`,
    });
    expect(findAgentNameForBridgeToken(token, { procRoot: "/proc", proc })).toBe("grok");
    expect(findAgentNameForBridgeToken("cc".repeat(32), { procRoot: "/proc", proc })).toBeUndefined();
  });

  it("healUnknownBearerFromProc adopts into registry", () => {
    const token = "cd".repeat(32);
    const reg = new CallerIdentityRegistry(KEY);
    expect(reg.resolve(token, SCOPE).ok).toBe(false);
    const proc = fakeProc({
      "/proc/7/stat": "7 (grok) S 1",
      "/proc/7/environ": `TACHYON_AGENT_NAME=grok\0TACHYON_AGENT_BRIDGE_TOKEN=${token}\0`,
    });
    const healed = healUnknownBearerFromProc(reg, token, SCOPE, { procRoot: "/proc", proc });
    expect(healed).toEqual({ ok: true, name: "grok", adopted: true });
    expect(reg.resolve(token, SCOPE)).toEqual({ ok: true, snapshot: { kind: "agent", name: "grok" } });
    // second heal is already_ok
    expect(healUnknownBearerFromProc(reg, token, SCOPE, { procRoot: "/proc", proc })).toEqual({
      ok: true,
      name: "grok",
      adopted: false,
    });
  });
});
