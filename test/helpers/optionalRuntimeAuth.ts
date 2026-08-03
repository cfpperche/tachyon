import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";

export type OptionalRuntime = "claude" | "codex" | "opencode";

export function optionalRuntimeCredential(runtime: OptionalRuntime, env = process.env, home = os.homedir()): string {
  if (runtime === "claude") return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"), ".credentials.json");
  if (runtime === "codex") return path.join(env.CODEX_HOME?.trim() || path.join(home, ".codex"), "auth.json");
  return path.join(env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share"), "opencode", "auth.json");
}

export function optionalRuntimeCredentialAvailable(runtime: OptionalRuntime): boolean {
  try {
    fs.accessSync(optionalRuntimeCredential(runtime), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * t-eccb00 — these tests reach a real runtime credential only as optional harness substrate.
 * Skip before the test body runs when that substrate is absent; ctx.skip(note) makes Vitest own the
 * pending result and its reason. Unknown test titles are never skipped.
 */
export function skipTestsWithoutOptionalRuntimeAuth(tests: Partial<Record<OptionalRuntime, readonly string[]>>): void {
  beforeEach(async (context) => {
    for (const runtime of ["claude", "codex", "opencode"] as const) {
      if (!tests[runtime]?.includes(context.task.name) || optionalRuntimeCredentialAvailable(runtime)) continue;
      const reason = `optional ${runtime} credential unavailable at ${optionalRuntimeCredential(runtime)}`;
      (context.task.meta as Record<string, unknown>).optionalRuntimeAuthUnavailable = runtime;
      await context.annotate(reason, "skip");
      context.skip(reason);
    }
  });
}
