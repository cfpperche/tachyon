/**
 * t-0ac2e9 — the pure half of the runtime re-measurement command.
 *
 * The runner in `runtime-remeasure.ts` drives the real CLI. This module only reads what the CLI
 * printed and decides a verdict. The split exists so a unit test can hold the decisions against
 * captured output, without a CLI on the machine.
 *
 * Every fixture in `test/unit/runtimeRemeasure.test.ts` is real output from codex-cli 0.146.1,
 * captured on 2026-08-06. No fixture is invented.
 */

/** What one dimension says about the installed CLI. */
export type Verdict = "holds" | "changed" | "not-measured";

export interface DimensionResult {
  /** short id, used on the report line */
  readonly id: string;
  readonly title: string;
  /** the file and line where the behaviour is compiled into the product */
  readonly anchor: string;
  /** the CLI version the record was taken on */
  readonly recordedVersion: string;
  /** what the product records today */
  readonly recorded: string;
  /** what the installed CLI did */
  readonly observed: string;
  readonly verdict: Verdict;
  /** why it changed, or why nothing was measured */
  readonly reason?: string;
}

/**
 * Read the accepted values out of a Codex config error.
 *
 * Codex prints two shapes. Three or more values read `expected one of `a`, `b`, `c``. Exactly two
 * read `expected `a` or `b``. This takes every backticked token after the word `expected`, so both
 * shapes work. It returns an empty list when the text holds no such list.
 */
export function parseExpectedVariants(text: string): string[] {
  const at = text.indexOf("expected");
  if (at < 0) return [];
  const tail = text.slice(at);
  const stop = tail.indexOf("\n");
  const line = stop < 0 ? tail : tail.slice(0, stop);
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

export interface VariantComparison {
  readonly verdict: Verdict;
  /** recorded by the product, refused by the CLI now */
  readonly missing: string[];
  /** accepted by the CLI, absent from the product record */
  readonly added: string[];
}

/**
 * Compare the product's allowlist to the CLI's own list.
 *
 * `excluded` names values the product drops on purpose. `granular` is one: the projection documents
 * it as a TOML table rather than a scalar, so it can never arrive on this path. An excluded value is
 * reported, never counted as drift.
 */
export function compareVariantSets(
  recorded: readonly string[],
  observed: readonly string[],
  excluded: readonly string[] = [],
): VariantComparison {
  if (observed.length === 0) return { verdict: "not-measured", missing: [], added: [] };
  const observedSet = new Set(observed);
  const recordedSet = new Set(recorded);
  const missing = recorded.filter((value) => !observedSet.has(value));
  const added = observed.filter((value) => !recordedSet.has(value) && !excluded.includes(value));
  const verdict: Verdict = missing.length === 0 && added.length === 0 ? "holds" : "changed";
  return { verdict, missing, added };
}

/** The Codex startup screens this probe can tell apart. */
export type CodexScreen = "trust-prompt" | "sign-in" | "ready" | "unknown";

/**
 * Name the screen a Codex pane is showing.
 *
 * The order matters. The trust prompt draws no version banner, so it is tested first. `sign-in` is
 * the screen that produced the trap this probe guards: with no credential the trust prompt never
 * appears, and an absent prompt reads exactly like inherited trust.
 */
export function classifyCodexScreen(pane: string): CodexScreen {
  if (/Do you trust the contents of this directory\?/.test(pane)) return "trust-prompt";
  if (/Sign in with ChatGPT/.test(pane)) return "sign-in";
  if (/OpenAI Codex \(v/.test(pane)) return "ready";
  return "unknown";
}

export interface TrustScreens {
  /** cwd is the exact directory the private config trusts */
  readonly exact: CodexScreen;
  /** cwd is a child of that directory */
  readonly child: CodexScreen;
  /** cwd is that child, and argv `-c` grants trust to it */
  readonly argv: CodexScreen;
}

/**
 * Decide the directory-trust dimension.
 *
 * The `exact` case is the control. It must reach the ready screen. Codex asks nothing there because
 * the private config trusts that exact path. If the control does not reach that screen, the probe
 * proves nothing about the other two, and the answer is `not-measured` with the screen named.
 */
export function trustVerdict(screens: TrustScreens): { verdict: Verdict; reason?: string } {
  if (screens.exact === "sign-in") {
    return {
      verdict: "not-measured",
      reason: "codex asked for sign-in, so the trust prompt was never reached. Run `codex login` first.",
    };
  }
  if (screens.exact !== "ready") {
    return {
      verdict: "not-measured",
      reason: `the control run showed '${screens.exact}' instead of the ready screen, so no case is decidable.`,
    };
  }
  if (screens.child === "ready") {
    return {
      verdict: "changed",
      reason: "a child of a trusted directory is now trusted. Trust is inherited by prefix.",
    };
  }
  if (screens.argv === "ready") {
    return {
      verdict: "changed",
      reason: "argv `-c projects.<path>.trust_level` now grants trust. The private config is no longer the only channel.",
    };
  }
  if (screens.child !== "trust-prompt" || screens.argv !== "trust-prompt") {
    return {
      verdict: "not-measured",
      reason: `an unknown screen appeared (child='${screens.child}', argv='${screens.argv}').`,
    };
  }
  return { verdict: "holds" };
}

/**
 * Decide the `--full-auto` dimension.
 *
 * Two records must agree. The CLI must still refuse the flag. The chip list must still omit it.
 * A chip list that offers a refused flag hands the human a command that cannot start.
 */
export function fullAutoVerdict(rejectedByCli: boolean, offeredAsChip: boolean): { verdict: Verdict; reason?: string } {
  if (rejectedByCli && !offeredAsChip) return { verdict: "holds" };
  if (!rejectedByCli && !offeredAsChip) {
    return { verdict: "changed", reason: "the CLI accepts `--full-auto` again. The chip may be offered once someone measures what it does." };
  }
  if (rejectedByCli && offeredAsChip) {
    return { verdict: "changed", reason: "the chip list offers `--full-auto` and the CLI still refuses it. The suggestion cannot launch." };
  }
  return { verdict: "changed", reason: "the CLI accepts `--full-auto` and the chip list offers it. The record is stale, not wrong." };
}

export interface MemoryStates {
  /** an empty private CODEX_HOME */
  readonly byDefault: string;
  /** `--enable memories` on argv */
  readonly enableFlag: string;
  /** `[features] memories = true` in the private config */
  readonly configFile: string;
}

/**
 * Decide the native-memory dimension.
 *
 * The product rests on two facts. Memory is off by default. Both control paths move it. A default
 * that flipped to on is the dangerous one: the canonical config names no memory key, so nothing in
 * the projection would turn it back off.
 */
export function memoryVerdict(states: MemoryStates): { verdict: Verdict; reason?: string } {
  if (states.byDefault === "unknown") {
    return { verdict: "not-measured", reason: "the `memories` row is absent from `codex features list`." };
  }
  if (states.byDefault !== "disabled") {
    return { verdict: "changed", reason: "memory is ON by default. The canonical config names no memory key, so nothing turns it off." };
  }
  const broken = [
    states.enableFlag !== "enabled" ? "`--enable memories` no longer turns it on" : "",
    states.configFile !== "enabled" ? "`[features] memories = true` no longer turns it on" : "",
  ].filter(Boolean);
  if (broken.length > 0) return { verdict: "changed", reason: `${broken.join("; ")}.` };
  return { verdict: "holds" };
}

/** Count the verdicts for the closing line of the report. */
export function summarize(results: readonly DimensionResult[]): Record<Verdict, number> {
  return {
    holds: results.filter((r) => r.verdict === "holds").length,
    changed: results.filter((r) => r.verdict === "changed").length,
    "not-measured": results.filter((r) => r.verdict === "not-measured").length,
  };
}

