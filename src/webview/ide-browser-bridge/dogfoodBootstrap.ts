/**
 * Auto dogfood for IDE browser bridge (Dev Host only).
 *
 * When the open workspace has `.tachyon/ide-browser-dogfood.json`:
 * 1. Ensure Saved Agent `grok` exists (create if missing)
 * 2. Start it if not running
 * 3. Send the dogfood prompt once per workspace generation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { savedAgentCreateMutation } from "../../agents/savedAgentProposal.js";
import type { WorkspaceShellHandle } from "../../shell/WorkspaceShellHandle.js";

export type DogfoodMarker = {
  schemaVersion: 1;
  kind: "ide-browser-dogfood";
  agent?: string;
  prompt?: string;
};

const DEFAULT_PROMPT = [
  "You are dogfooding Tachyon's Integrated Browser bridge.",
  "1) ide_browser_status",
  "2) ide_browser_navigate https://example.com",
  "3) ide_browser_snapshot — short summary",
  "4) If tools missing, say bridge offline.",
].join("\n");

export function readDogfoodMarker(workspaceRoot: string): DogfoodMarker | null {
  const file = path.join(workspaceRoot, ".tachyon", "ide-browser-dogfood.json");
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as DogfoodMarker;
    if (raw?.kind !== "ide-browser-dogfood" || raw.schemaVersion !== 1) return null;
    return raw;
  } catch {
    return null;
  }
}

function sentMarkerPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "ide-browser-dogfood.sent");
}

export async function runIdeBrowserDogfoodBootstrap(opts: {
  getWorkspace: () => WorkspaceShellHandle | undefined;
  log: (line: string) => void;
  /** Wait for engine to accept queries */
  waitMs?: number;
}): Promise<{ ok: boolean; detail: string }> {
  const waitMs = opts.waitMs ?? 45_000;
  const deadline = Date.now() + waitMs;
  let ws = opts.getWorkspace();
  while (!ws && Date.now() < deadline) {
    await sleep(500);
    ws = opts.getWorkspace();
  }
  if (!ws) return { ok: false, detail: "no Tachyon workspace yet" };

  const marker = readDogfoodMarker(ws.workspaceRoot);
  if (!marker) return { ok: false, detail: "no ide-browser-dogfood marker" };

  const agentName = (marker.agent || "grok").trim() || "grok";
  const prompt = (marker.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT;
  opts.log(`[dogfood] marker found agent=${agentName}`);

  // Wait until engine answers agents.list
  let listed: unknown = null;
  while (Date.now() < deadline) {
    try {
      listed = await ws.extension.query({ action: "agents.list" });
      break;
    } catch (err) {
      opts.log(`[dogfood] agents.list not ready: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(800);
    }
  }
  if (listed === null) return { ok: false, detail: "engine never answered agents.list" };

  const rows = Array.isArray(listed) ? listed as Array<{ name?: string; running?: boolean }> : [];
  let row = rows.find((r) => r.name === agentName);

  if (!row) {
    opts.log(`[dogfood] creating Saved Agent ${agentName} (grok)`);
    try {
      // createSavedAgent does YAML setIn(['agents', name], …) — needs agents: to be a map.
      await ensureAgentsMapInConfig(ws.workspaceRoot, opts.log);
      await ws.createSavedAgent(
        savedAgentCreateMutation(agentName, {
          displayName: "Grok (IDE browser dogfood)",
          runtimeAdapter: "grok",
          executable: "grok",
          workspace: { worktree: false },
        }),
        {},
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Already exists race
      if (!/already|exists|conflict/i.test(msg)) {
        return { ok: false, detail: `createSavedAgent failed: ${msg}` };
      }
      opts.log(`[dogfood] create reported: ${msg}`);
    }
    await sleep(500);
    try {
      listed = await ws.extension.query({ action: "agents.list" });
    } catch {
      /* ignore */
    }
    const again = Array.isArray(listed) ? listed as Array<{ name?: string; running?: boolean }> : [];
    row = again.find((r) => r.name === agentName);
    if (!row) return { ok: false, detail: `agent ${agentName} still missing after create` };
  }

  if (!row.running) {
    opts.log(`[dogfood] starting ${agentName}`);
    try {
      const result = await ws.client.invoke(`ide-browser-dogfood-start:${Date.now()}`, {
        schemaVersion: 1,
        method: "agent.start",
        input: { agent: agentName },
      });
      if (result.status === "error") {
        return { ok: false, detail: `agent.start failed: ${result.message}` };
      }
    } catch (err) {
      return { ok: false, detail: `agent.start failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Give runtime a moment to attach Bridge tools
    await sleep(2500);
  }

  const sentPath = sentMarkerPath(ws.workspaceRoot);
  if (fs.existsSync(sentPath)) {
    opts.log("[dogfood] prompt already sent this fixture generation — skip inject");
    return { ok: true, detail: "already sent" };
  }

  opts.log(`[dogfood] injecting dogfood prompt into ${agentName}`);
  try {
    await ws.activity.sendAgentInput(agentName, prompt, true);
  } catch (err) {
    return { ok: false, detail: `sendAgentInput failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    fs.mkdirSync(path.dirname(sentPath), { recursive: true });
    fs.writeFileSync(sentPath, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    /* non-fatal */
  }

  return { ok: true, detail: `started ${agentName} and sent dogfood prompt` };
}

/**
 * saved-agent-create does `doc.setIn(["agents", name], …)`. If `agents` is missing,
 * the yaml lib throws "Expected YAML collection at agents". Ensure an empty map exists.
 */
function ensureAgentsMapInConfig(workspaceRoot: string, log: (line: string) => void): void {
  const candidates = ["tachyon.yml", "tachyon.yaml"].map((n) => path.join(workspaceRoot, n));
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    log("[dogfood] no tachyon.yml to patch agents map");
    return;
  }
  const text = fs.readFileSync(file, "utf8");
  // Already has a non-null agents mapping (including empty `agents: {}`).
  if (/^agents:\s*(\{\s*\})?\s*$/m.test(text) || /^agents:\s*$/m.test(text) || /^agents:\s*\n(?:  |\t)/m.test(text)) {
    // `agents:` with no value is null in YAML — still need `{}`
    if (/^agents:\s*$/m.test(text) && !/^agents:\s*\{\s*\}/m.test(text) && !/^agents:\s*\n  \S/m.test(text)) {
      const next = text.replace(/^agents:\s*$/m, "agents: {}");
      fs.writeFileSync(file, next, "utf8");
      log("[dogfood] patched null agents: → agents: {}");
    }
    return;
  }
  if (/^agents:/m.test(text)) return;
  // Insert empty agents map after settings block or at top.
  const next = text.includes("\nsettings:") || text.startsWith("settings:")
    ? text.replace(/(^settings:[\s\S]*?(?=\n[a-zA-Z]|\n*$))/m, (block) => `${block.trimEnd()}\n\nagents: {}\n`)
    : `agents: {}\n\n${text}`;
  if (next === text) {
    fs.writeFileSync(file, `agents: {}\n\n${text}`, "utf8");
  } else {
    fs.writeFileSync(file, next, "utf8");
  }
  log("[dogfood] inserted agents: {} into tachyon.yml");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
