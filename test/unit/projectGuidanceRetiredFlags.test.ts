import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
// Owned ESM CLI; Vitest loads it directly while the repo typecheck target is CommonJS — the same
// intentional shape (and the same suppression) `devHostPointer.test.ts` uses for this module.
// @ts-expect-error -- static ESM import is intentional for this executable module test.
import { RETIRED_FLAGS } from "../../scripts/dev-host/pointer.mjs";

/**
 * t-3e5072 — the transported project guidance must never INSTRUCT a retired dev-host flag again.
 *
 * Follow-up to t-fb2a67/t-27e918: `237af29b` corrected `docs/project-guidance.md` after it had been
 * telling agents to run flags spec 448 removed, but shipped no guard, so the same text could drift
 * back. The cost of that drift is specific — this document is transported into every agent's startup
 * brief, so a wrong instruction here is executed by every agent at once, and each one then hits a
 * refusal it was told to expect to work.
 *
 * Two design rules, both from the task:
 *
 *  1. **Derive, never restate.** The flag set is imported from `RETIRED_FLAGS` in
 *     `scripts/dev-host/pointer.mjs` — the same frozen object `parseArgs` refuses on. A seventh
 *     retirement extends this guard by existing; nobody has to remember a second list.
 *  2. **An instruction is not a mention.** The guidance legitimately explains the removal ("Spec 448
 *     removed … `--owner`, `--slot` …"), and a guard that banned the words would forbid the very
 *     sentence that teaches the change. So the unit checked is a dev-host COMMAND, not the file.
 *
 * Scope is the transported set and nothing else. `tachyon.yml` — where `settings.projectGuidance.files`
 * actually lives — is GITIGNORED per-checkout config: reading it alone would make this guard pass on
 * the primary checkout and vanish in every worktree and fresh clone, which is the shape of a test that
 * looks green because it stopped running. So the tracked document is the baseline (the same constant
 * `projectGuidanceOwnership.test.ts` uses), and a `tachyon.yml` that IS present adds whatever else it
 * declares. No other tree is walked, and nothing here parses Markdown beyond finding the code spans
 * commands are written in.
 */

const repoRoot = process.cwd();

/** The dev-host entry points a human is ever told to run. A command span is one that names one. */
const DEV_HOST_COMMANDS = ["dogfood:dev-host", "dogfood -- dev-host", "dev-host/pointer.mjs"];

/** The banned set, derived — the ESM CLI has no .d.ts in the CJS typecheck graph, hence the cast. */
const retiredFlags: string[] = Object.keys(RETIRED_FLAGS as Record<string, string>);

/**
 * This repository's own transported guidance, tracked in git so the guard runs everywhere. Kept as
 * the same literal `projectGuidanceOwnership.test.ts` asserts against, for one answer to "what does
 * Tachyon transport about itself".
 */
const TRACKED_GUIDANCE = ["docs/project-guidance.md"] as const;

/** Files transported into every agent's brief: the tracked baseline, plus anything a present
 *  (untracked) `tachyon.yml` additionally declares — so a second guidance file is covered the day it
 *  is declared, without the guard depending on a file most checkouts do not have. */
function transportedGuidanceFiles(): string[] {
  const declared: string[] = [];
  const configPath = path.join(repoRoot, "tachyon.yml");
  if (fs.existsSync(configPath)) {
    const config = parseYaml(fs.readFileSync(configPath, "utf8")) as {
      settings?: { projectGuidance?: { files?: unknown } };
    };
    const files = config.settings?.projectGuidance?.files;
    if (Array.isArray(files)) declared.push(...files.filter((file): file is string => typeof file === "string"));
  }
  return [...new Set([...TRACKED_GUIDANCE, ...declared])]
    .filter((file) => fs.existsSync(path.join(repoRoot, ...file.split("/"))));
}

/**
 * Every code span in the document: fenced blocks first, then inline backtick spans (which may wrap
 * across lines — the shipped guidance's own `npm run dogfood -- dev-host …` example does).
 *
 * This is deliberately the whole of the "parsing": commands in this document are written as code, so
 * a code span is the unit that separates "run this" from "this was removed". A command written as
 * bare prose would slip past — an accepted boundary, not an oversight, and the narrower rule is what
 * keeps the guard from banning the explanatory sentence.
 */
function codeSpans(markdown: string): string[] {
  const spans: string[] = [];
  const fenced = markdown.replace(/```[\s\S]*?```/g, (block) => {
    spans.push(block);
    return "\n";
  });
  for (const match of fenced.matchAll(/`([^`]+)`/g)) spans.push(match[1]);
  return spans;
}

export interface RetiredFlagInstruction {
  flag: string;
  command: string;
}

/**
 * Retired flags this text tells someone to RUN.
 *
 * A span counts only when it names a dev-host entry point, so `--owner` in a sentence about the
 * removal is invisible here while `npm run dogfood -- dev-host -- point --owner me` is not. Whitespace
 * is normalized because a wrapped code span carries newlines and indentation from the Markdown.
 */
export function retiredFlagInstructions(markdown: string): RetiredFlagInstruction[] {
  const found: RetiredFlagInstruction[] = [];
  for (const span of codeSpans(markdown)) {
    const command = span.replace(/\s+/g, " ").trim();
    if (!DEV_HOST_COMMANDS.some((entry) => command.includes(entry))) continue;
    for (const flag of retiredFlags) {
      // Word-bounded: `--all` must not match `--allow-x`, and `--activate` must not match itself
      // inside `--no-activate` twice over.
      if (new RegExp(`${flag}(?![\\w-])`).test(command)) found.push({ flag, command });
    }
  }
  return found;
}

describe("the transported project guidance never instructs a retired dev-host flag (t-3e5072)", () => {
  it("derives the banned set from the canonical RETIRED_FLAGS, not from a copy", () => {
    // If this ever reads zero, every assertion below passes vacuously.
    expect(retiredFlags.length).toBeGreaterThan(0);
    expect(retiredFlags).toEqual(expect.arrayContaining(["--owner", "--slot", "--activate", "--no-activate", "--require-owner", "--all"]));
  });

  it("scans the transported guidance, and runs in a worktree where tachyon.yml is absent", () => {
    const files = transportedGuidanceFiles();
    // The tracked document is always in the set — that is what keeps this guard alive in a checkout
    // without the (gitignored) config, instead of silently scanning nothing.
    expect(files).toContain("docs/project-guidance.md");
    for (const file of files) {
      expect(fs.existsSync(path.join(repoRoot, ...file.split("/"))), `${file} is declared but missing`).toBe(true);
    }
  });

  it("instructs none of them, in any transported file", () => {
    for (const file of transportedGuidanceFiles()) {
      const markdown = fs.readFileSync(path.join(repoRoot, ...file.split("/")), "utf8");
      const offences = retiredFlagInstructions(markdown);
      expect(
        offences,
        offences.length === 0 ? "" : `${file} tells an agent to run: ${offences.map((o) => `${o.flag} in \`${o.command}\``).join("; ")}`,
      ).toEqual([]);
    }
  });

  it("keeps `--worktree` usable — the guard bans the retired set, not dev-host flags in general", () => {
    expect(retiredFlags).not.toContain("--worktree");
    expect(retiredFlagInstructions("arm another checkout with `npm run dogfood -- dev-host -- point --worktree /wt/x --fixture s`")).toEqual([]);
    // and the shipped guidance really does still offer it, so the check above is about live text
    const guidance = transportedGuidanceFiles()
      .map((file) => fs.readFileSync(path.join(repoRoot, ...file.split("/")), "utf8"))
      .join("\n");
    expect(guidance).toContain("--worktree");
  });
});

describe("an instruction is distinguished from a mention", () => {
  it("catches a retired flag inside a dev-host command — the regression this guards", () => {
    const drifted = "cd to YOUR worktree and arm it with `npm run dogfood -- dev-host -- point --owner me --fixture sample`.";
    expect(retiredFlagInstructions(drifted)).toEqual([{ flag: "--owner", command: "npm run dogfood -- dev-host -- point --owner me --fixture sample" }]);
  });

  it("catches one inside a fenced block too", () => {
    const drifted = "```sh\nnpm run dogfood -- dev-host -- point-clear --all\n```";
    expect(retiredFlagInstructions(drifted).map((o) => o.flag)).toEqual(["--all"]);
  });

  it("ignores the sentence that EXPLAINS the removal — the shipped wording, verbatim", () => {
    const explanatory =
      "Spec 448 removed slots, the `active` pointer and the flags that selected them (`--owner`, `--slot`, "
      + "`--activate`, `--no-activate`, `--require-owner`, `--all`); each now fails immediately naming its replacement.";
    expect(retiredFlagInstructions(explanatory)).toEqual([]);
  });

  it("ignores a retired flag in a command that is not a dev-host one", () => {
    // `--owner` is a live lease flag elsewhere (`lane.mjs`); this guard is about the dev-host pointer.
    expect(retiredFlagInstructions("release it with `npm run dogfood -- lane -- release --owner me`")).toEqual([]);
  });

  it("does not fire on a flag that merely starts with a retired one", () => {
    expect(retiredFlagInstructions("`npm run dogfood -- dev-host -- point --allow-dirty`")).toEqual([]);
  });

  it("reports every retired flag a single drifted command carries", () => {
    const drifted = "`npm run dogfood -- dev-host -- point --slot 2 --activate --require-owner`";
    expect(retiredFlagInstructions(drifted).map((o) => o.flag).sort()).toEqual(["--activate", "--require-owner", "--slot"]);
  });
});
