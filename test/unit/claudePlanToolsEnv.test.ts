import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentManager } from "@tachyon/engine/agents/AgentManager.js";
import { parseConfig, type TachyonConfig } from "@tachyon/engine/config/loadConfig.js";
import { TmuxService, workspaceHash, sessionName, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import {
  CLAUDE_CODE_ENABLE_TODO_TOOLS,
  withClaudePlanToolsEnv,
} from "@tachyon/engine/runtime/claudePlanToolsEnv.js";

/**
 * t-96c1b3 — CLAUDE_CODE_ENABLE_TODO_TOOLS=1 on every Claude session-start door.
 *
 * Behaviour is asserted on the env tmux actually received. The source half names the two
 * doors (createOwnedSession, startSessionCommandUnlocked) so a third path cannot appear
 * as a silent miss.
 */

const WS = "/repo";
const HASH = workspaceHash(WS);
const SOURCE = fs.readFileSync(
  path.resolve("packages/engine/src/agents/AgentManager.ts"),
  "utf8",
);

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

function applyTmuxEnvToSession(sessionEnv: Map<string, Record<string, string>>, args: string[]): void {
  let session: string | undefined;
  const tIdx = args.indexOf("-t");
  if (tIdx >= 0 && args[tIdx + 1]) session = args[tIdx + 1]!.replace(/^=/, "").replace(/:$/, "");
  const sIdx = args.indexOf("-s");
  if (sIdx >= 0 && args[sIdx + 1]) session = args[sIdx + 1];
  if (!session) return;
  const env = sessionEnv.get(session) ?? {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" && args[i + 1]?.includes("=")) {
      const pair = args[++i]!;
      const eq = pair.indexOf("=");
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (args[i] === "set-environment") {
      let j = i + 1;
      let unset = false;
      while (args[j] === "-u" || args[j] === "-r" || args[j] === "-h" || args[j] === "-g" || args[j] === "-F") {
        if (args[j] === "-u" || args[j] === "-r") unset = true;
        j++;
      }
      if (args[j] === "-t") j += 2;
      const name = args[j];
      if (name !== undefined) {
        if (unset) delete env[name];
        else if (args[j + 1] !== undefined) env[name] = args[j + 1]!;
      }
      i = unset ? j : j + 1;
    }
  }
  sessionEnv.set(session, env);
}

function fakeTmux() {
  const sessions = new Set<string>();
  const sessionEnv = new Map<string, Record<string, string>>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1]!;
      sessions.add(name);
      applyTmuxEnvToSession(sessionEnv, args);
      return { stdout: "", stderr: "" };
    }
    if (args.includes("respawn-pane")) {
      applyTmuxEnvToSession(sessionEnv, args);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "list-sessions":
        return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
      case "list-panes":
        return {
          stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + (sessions.size ? "\n" : ""),
          stderr: "",
        };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, sessionEnv, tmux: new TmuxService(exec) };
}

function makeManager(yaml: string) {
  const fake = fakeTmux();
  const manager = new AgentManager({
    tmux: fake.tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => configOf(yaml),
    launchPreflight: hermeticLaunchPreflight(),
  });
  return { manager, ...fake };
}

function methodsContaining(pattern: RegExp): string[] {
  const lines = SOURCE.split("\n");
  const found = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!pattern.test(line)) continue;
    let owner = "<top level>";
    for (let above = index; above >= 0; above--) {
      const signature = /^ {2}(?:private |public |protected )?(?:async )?([a-zA-Z_][\w]*)\(/.exec(lines[above]!);
      if (signature) { owner = signature[1]!; break; }
    }
    found.add(owner);
  }
  return [...found].sort();
}

describe("t-96c1b3 — withClaudePlanToolsEnv", () => {
  it("opts Claude in and leaves other runtimes untouched", () => {
    expect(withClaudePlanToolsEnv({ FOO: "1" }, "claude")).toEqual({
      FOO: "1",
      [CLAUDE_CODE_ENABLE_TODO_TOOLS]: "1",
    });
    expect(withClaudePlanToolsEnv({ FOO: "1" }, "codex")).toEqual({ FOO: "1" });
    expect(withClaudePlanToolsEnv({ FOO: "1" }, "grok")).toEqual({ FOO: "1" });
  });

  it("overwrites a caller who tried to leave the tools off", () => {
    expect(withClaudePlanToolsEnv({ [CLAUDE_CODE_ENABLE_TODO_TOOLS]: "0" }, "claude")[CLAUDE_CODE_ENABLE_TODO_TOOLS])
      .toBe("1");
  });

  it("does not mutate the caller's env object", () => {
    const original = { FOO: "1" };
    withClaudePlanToolsEnv(original, "claude");
    expect(original).toEqual({ FOO: "1" });
  });
});

describe("t-96c1b3 — Claude launch env (production doors)", () => {
  it("spawn of a Claude agent carries CLAUDE_CODE_ENABLE_TODO_TOOLS=1", async () => {
    const { manager, sessionEnv } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    expect(sessionEnv.get(sessionName(HASH, "claude"))?.[CLAUDE_CODE_ENABLE_TODO_TOOLS]).toBe("1");
  });

  it("restart of a Claude agent still carries the flag", async () => {
    const { manager, sessionEnv } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    await manager.restart("claude", { stop: "force", session: "new" });
    expect(sessionEnv.get(sessionName(HASH, "claude"))?.[CLAUDE_CODE_ENABLE_TODO_TOOLS]).toBe("1");
  });

  it("a non-Claude agent does not receive the flag", async () => {
    const { manager, sessionEnv } = makeManager("agents:\n  grok:\n    cmd: grok\n");
    await manager.spawn("grok");
    expect(sessionEnv.get(sessionName(HASH, "grok"))?.[CLAUDE_CODE_ENABLE_TODO_TOOLS]).toBeUndefined();
  });

  it("both session-start doors apply the helper; no inline env assignment", () => {
    expect(SOURCE).not.toMatch(/CLAUDE_CODE_ENABLE_TODO_TOOLS\s*:/);
    expect(methodsContaining(/withClaudePlanToolsEnv\(/)).toEqual([
      "createOwnedSession",
      "startSessionCommandUnlocked",
    ]);
  });
});
