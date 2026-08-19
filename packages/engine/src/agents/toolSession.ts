/**
 * t-ba0d68 — tool-session identity the launcher stamps from the invoking agent.
 *
 * The agent-browser `--session` name used to be the agent's choice. Teardown then could
 * not know what to close. The launcher rewrites (and, for browser-kind tools, injects)
 * `--session` from `TACHYON_AGENT_NAME`, so the name is `tachyon-<agent>` and reconstructible
 * after the agent is already gone.
 *
 * Pure: this module is bundled into `_tachyon-tool.js` (a git-hook path). Close/spawn lives
 * in `closeAgentToolSessions.ts` so the launcher does not ship teardown.
 */
export const TOOL_SESSION_FLAG = "--session";

export function toolSessionNameForAgent(agent: string): string {
  return `tachyon-${agent}`;
}

/** Same heuristic the launcher uses to classify a provisioned tool as a browser. */
export function toolUsesStampedSession(pluginName: string, toolName: string): boolean {
  const label = `${pluginName} ${toolName}`.toLowerCase();
  return label.includes("browser") || label.includes("chrome") || label.includes("chromium") || label.includes("edge");
}

export function argvHasSessionFlag(argv: readonly string[]): boolean {
  return argv.some((a) => a === TOOL_SESSION_FLAG || a.startsWith(`${TOOL_SESSION_FLAG}=`));
}

/**
 * Rewrite every `--session` / `--session=` to the stamped name. Duplicate flags collapse to one.
 * When `injectIfMissing` is set and the agent omitted the flag, prepend it — otherwise a browser
 * tool would fall through to the shared `default` session, which teardown cannot attribute.
 */
export function stampToolSessionArgv(
  argv: readonly string[],
  agent: string,
  opts?: { injectIfMissing?: boolean },
): string[] {
  const stamped = toolSessionNameForAgent(agent);
  const out: string[] = [];
  let seen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === TOOL_SESSION_FLAG) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      if (!seen) {
        out.push(TOOL_SESSION_FLAG, stamped);
        seen = true;
      }
      continue;
    }
    if (a.startsWith(`${TOOL_SESSION_FLAG}=`)) {
      if (!seen) {
        out.push(TOOL_SESSION_FLAG, stamped);
        seen = true;
      }
      continue;
    }
    out.push(a);
  }
  if (!seen && opts?.injectIfMissing) out.unshift(TOOL_SESSION_FLAG, stamped);
  return out;
}
