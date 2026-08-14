/**
 * t-f22211 — Claude Code's native memory, measured rather than declared.
 *
 * The first consumer of `nativeMemory.ts` (t-56daa1). Its job is to say
 * which axes Claude Code 2.1.220 can be held to WITHOUT billing anyone, and to be explicit about the
 * ones it cannot — because "we could not check" is the answer the whole lane exists to make visible.
 *
 * ## What was measured (2026-07-28, Claude Code 2.1.220, sandboxed CLAUDE_CONFIG_DIR)
 *
 * `claude project purge <path> --dry-run -y` is a genuine non-billable inspection path, and it turned
 * out to answer more than its name suggests:
 *
 *   Purge plan for <repo>:
 *     dir:    <CLAUDE_CONFIG_DIR>/projects/<project-key>
 *              project transcripts (.jsonl) and memory/
 *   backups/ may still contain this project entry in old .claude.json snapshots …
 *
 * From that, three things are observable with no model call:
 *
 *  1. **The store's location is bound to the private home.** With `CLAUDE_CONFIG_DIR` pointed at a
 *     temporary directory, Claude resolved project state under THAT directory and named the path. It
 *     also created `projects/` and `backups/` there rather than in the real home.
 *  2. **The store is enumerable without reading it.** The purge plan names the directory and what it
 *     contains (`transcripts and memory/`) — the inventory axis, answered without opening a single
 *     memory file, which is what "must not inspect user memory" requires.
 *  3. **Purge works, and discloses its own residue.** A planted marker was gone from the whole
 *     sandbox afterwards. The plan warns, unprompted, that `backups/` may still hold the project entry
 *     in rotated `.claude.json` snapshots — so "purged" is not "every byte is gone", and a product
 *     that promises deletion has to say that too.
 *
 * ## What could NOT be measured, and why that is the finding
 *
 * Disable, enable, injection and mutation all require observing what reaches the model. Claude Code
 * 2.1.220 exposes no non-billable path that shows it: `--print` runs a real turn, and no dry-run,
 * dump or simulate flag exists (`claude --help`, checked). `doctor` is non-billable but reports
 * nothing about memory.
 *
 * So those four axes stay `declared`, and by `resolveMemoryPolicy`'s rules that keeps canonical
 * policy at `disabled` and `runtime-managed` BLOCKED — which is exactly the task's stated default.
 * Promoting them needs one explicitly authorized minimal model call, which this module refuses to
 * make on its own: `claudeMemoryVerificationPlan` reports what such a run would cost and prove.
 */
import path from "node:path";
import type { RuntimeNativeMemoryCapabilityV1 } from "@tachyon/engine/runtime/nativeMemory.js";
import type { MemoryLifecycleOperation } from "@tachyon/engine/runtime/nativeMemory.js";

/** The exact runtime this evidence describes. A different build is unmeasured until someone measures it. */
export const CLAUDE_MEMORY_MEASURED_VERSION = "2.1.220";

/**
 * How Claude keys a project directory under the config home: the absolute repo path with every
 * separator replaced by `-`. Measured, not documented — `/tmp/x/repo` resolved to `-tmp-x-repo`.
 */
export function claudeProjectKey(repoPath: string): string {
  return path.resolve(repoPath).split(path.sep).join("-");
}

/** Where the built-in store lives for one repo, inside a given config home. */
export function claudeMemoryStorePath(configHome: string, repoPath: string): string {
  return path.join(configHome, "projects", claudeProjectKey(repoPath), "memory");
}

/** The non-billable inspection this adapter relies on, as an argv a caller can run verbatim. */
export function claudePurgePlanArgv(repoPath: string): string[] {
  return ["project", "purge", path.resolve(repoPath), "--dry-run", "-y"];
}

export interface ClaudePurgePlan {
  /** directories the plan names — each must resolve under the sandbox, or the run is refused */
  readonly targets: string[];
  /** true when the plan says the store contains memory, which is the inventory observation */
  readonly namesMemory: boolean;
  /**
   * Residue the plan discloses about itself. Kept because "purged" that leaves rotated snapshots is a
   * fact a product promising deletion has to carry, not a footnote.
   */
  readonly residue: string | null;
}

/**
 * Parse the purge plan. Tolerant by design: this reads a human-facing CLI, so it extracts the two
 * things that carry meaning (the paths, and whether memory is named) and treats everything else as
 * prose. A stricter parse would break on the next wording change and prove nothing extra.
 */
export function parseClaudePurgePlan(stdout: string): ClaudePurgePlan {
  const targets: string[] = [];
  for (const match of stdout.matchAll(/^\s*dir:\s+(\S+)\s*$/gm)) targets.push(match[1]);
  const residueMatch = /backups\/[^\n]*/.exec(stdout);
  return {
    targets,
    namesMemory: /memory\//.test(stdout),
    residue: residueMatch ? residueMatch[0] : null,
  };
}

/**
 * Claude's capability with the axes this task actually verified.
 *
 * `inventory` is promoted because the purge plan enumerates the store without reading it. Everything
 * else stays where the research left it, and the notes say precisely why — including `isolation`,
 * which is the one a generous reading would have promoted: the store's PATH is provably bound to the
 * private home, but whether a LIVE session writes only there is a different claim needing a session,
 * so it stays `declared`. Verified has to mean observed, including when the observation is nearly
 * enough.
 */
export function claudeMemoryCapability(base: RuntimeNativeMemoryCapabilityV1): RuntimeNativeMemoryCapabilityV1 {
  return {
    ...base,
    runtimeVersion: CLAUDE_MEMORY_MEASURED_VERSION,
    evidence: { ...base.evidence, inventory: "verified" },
    sources: [
      ...base.sources,
      { kind: "behavioral-test", ref: "test/unit/claudeMemoryAdapter.test.ts" },
      { kind: "behavioral-test", ref: "docs/research/runtime-native-memory-parity-t-d4c42e.md#claude-2026-07-28" },
    ],
  };
}

export interface ClaudeVerificationPlan {
  /** axes a non-billable run can answer today */
  readonly withoutModelCall: readonly string[];
  /** axes that need one authorized minimal turn, with what each would prove */
  readonly needsAuthorization: ReadonlyArray<{ readonly axis: string; readonly proves: string }>;
  /** the lifecycle operations the task asks about, and how each would be exercised */
  readonly lifecycle: ReadonlyArray<{ readonly operation: MemoryLifecycleOperation; readonly method: string }>;
}

/**
 * What a full Claude verification would take — stated so a human can decide whether to authorize it,
 * rather than discovering the cost when a bill arrives.
 */
export function claudeMemoryVerificationPlan(): ClaudeVerificationPlan {
  return {
    withoutModelCall: [
      "inventory — `claude project purge --dry-run` names the store and its contents without opening a memory file",
      "purge — the same plan previews the exact target, and a real purge removes it (planted marker gone from the sandbox)",
      "store path binding — with CLAUDE_CONFIG_DIR set to a sandbox, Claude resolves and creates state there, not in the real home",
    ],
    needsAuthorization: [
      { axis: "disable", proves: "that autoMemoryEnabled:false / CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 stops a planted marker from reaching model input" },
      { axis: "enable", proves: "that the same marker DOES reach model input when memory is on" },
      { axis: "injection", proves: "that what reaches input stays within the declared 200-line / 25 KiB startup bound" },
      { axis: "mutation", proves: "whether a turn boundary writes memory back into the store" },
    ],
    lifecycle: [
      { operation: "fresh", method: "new sandbox home; observe whether the marker is present at first turn" },
      { operation: "restart", method: "same home, second session; the store should persist (research says retain)" },
      { operation: "resume", method: "same home, resumed session; retain expected" },
      { operation: "fork", method: "Tachyon's fork mints a DISTINCT private home — the marker must be absent, which is the claim worth proving most" },
    ],
  };
}
