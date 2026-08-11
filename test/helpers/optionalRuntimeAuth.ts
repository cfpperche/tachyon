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
 * The state goes in through the door production reads it from — `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
 * `XDG_DATA_HOME`, resolved by `realConfigHome()` / `defaultRealCodexHome()` /
 * `defaultRealOpencodeDataHome()` when the Workspace builds its `HarnessManager` — pointed at a
 * directory this helper owns and deletes.
 *
 * t-b10d93 — `opencode` was excluded here until 2026-08-11, on the grounds that its launch preflight
 * EXECUTES the runtime (`opencode providers list`) so no file could stand in. That was true of the
 * preflight and never true of the second door: `t-35c998` took the preflight out of the path with a
 * hermetic seam (`hermeticLaunchPreflight`), and what stayed red was `HarnessManager.materializeHome`
 * refusing to materialize an XDG home with no `<XDG_DATA_HOME>/opencode/auth.json` to copy — substrate,
 * a file the materializer reads, which is exactly the case this helper exists for. A file suffices;
 * the binary does not have to be installed. Measured on a host with `opencode` off the PATH and
 * `XDG_DATA_HOME` empty: the 27 tests that used to go pending in `workspaceHeadless`,
 * `humanDraftHoldsNotice`, `notifyDoorbellDelivery` and `cxNoticeBehavior.gen` run and pass.
 * A file is only enough where the preflight is already hermetic — a test that spawns `cmd: opencode`
 * through the REAL preflight registry still executes the runtime, and injecting auth here does not
 * change that.
 */
export function useDisposableRuntimeAuth(runtimes: readonly OptionalRuntime[]): void {
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
      } else if (runtime === "opencode") {
        // `home` is the XDG_DATA_HOME ROOT, not the runtime's own dir: opencode's auth lives one level
        // in, at `<XDG_DATA_HOME>/opencode/auth.json` (the adapter's `authFiles` entry the materializer
        // joins onto the root). Same shape as `optionalRuntimeCredential("opencode")` above.
        fs.mkdirSync(path.join(home, "opencode"), { recursive: true });
        fs.writeFileSync(path.join(home, "opencode", "auth.json"), '{"anthropic":{"type":"api","key":"fixture-only"}}\n', "utf8");
        vi.stubEnv("XDG_DATA_HOME", home);
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
 *
 * t-ed0f43 — as of 2026-08-11 this has ZERO call sites: the last four moved to
 * `useDisposableRuntimeAuth` once both doors were hermetic. It is kept, not deleted, because the two
 * answers are not interchangeable — this one is still the right answer wherever the MACHINE is what
 * the test measures (the runtime binary actually executing, as in the codex dogfood case), and there
 * injecting a file would fake the very thing under test.
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
