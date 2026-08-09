import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

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
 * t-a12966 — the OTHER verdict for the same dependency: inject it.
 *
 * `skipTestsWithoutOptionalRuntimeAuth` below is right when the machine is what the test measures.
 * It is the wrong answer when the credential is only substrate — a file the harness materializer
 * symlinks so a spawn can proceed — because then the test's result depends on whether the HOST is
 * logged in, and the same suite covers 66 more tests on the maintainer's checkout than in an agent's
 * worktree. Measured 2026-08-09: with a fixture credential in place, every claude- and codex-listed
 * test in `workspaceHeadless`, `continuityWiring`, `humanDraftHoldsNotice` and their siblings ran and
 * passed; only the opencode ones stayed red, and those are a different dependency (see below).
 *
 * The state goes in through the door production reads it from — `CLAUDE_CONFIG_DIR` / `CODEX_HOME`,
 * resolved by `realConfigHome()` / `defaultRealCodexHome()` when the Workspace builds its
 * `HarnessManager` — pointed at a directory this helper owns and deletes.
 *
 * `opencode` is deliberately NOT offered. Its launch preflight EXECUTES the runtime
 * (`opencode providers list`) to answer "is this authenticated?", so a credential file proves
 * nothing and the binary would still have to be installed. Those stay declared-and-skipped.
 */
export function useDisposableRuntimeAuth(runtimes: readonly Exclude<OptionalRuntime, "opencode">[]): void {
  const homes: string[] = [];
  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-fixture-auth-"));
    homes.push(base);
    for (const runtime of runtimes) {
      const home = path.join(base, runtime);
      fs.mkdirSync(home, { recursive: true });
      if (runtime === "claude") {
        fs.writeFileSync(path.join(home, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"fixture-only"}}\n', "utf8");
        fs.writeFileSync(path.join(home, ".claude.json"), `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, "utf8");
        vi.stubEnv("CLAUDE_CONFIG_DIR", home);
      } else {
        fs.writeFileSync(path.join(home, "auth.json"), '{"OPENAI_API_KEY":"fixture-only"}\n', "utf8");
        vi.stubEnv("CODEX_HOME", home);
      }
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });
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
