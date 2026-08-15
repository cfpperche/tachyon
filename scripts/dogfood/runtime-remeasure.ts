/**
 * t-0ac2e9 — re-measure the runtime behaviour that is compiled into this product.
 *
 * Half 1 of the drift work (t-1322b5) made the product say "this measurement may be old". It reads
 * the CLI on PATH and compares it to the measured constant. This command answers the other half:
 * does the recorded behaviour still hold on the CLI that is installed now.
 *
 * Run: `node scripts/dogfood/run.mjs runtime-remeasure`
 *
 * ## The four dimensions
 *
 * Each one is a runtime fact that a source file acts on. Each one causes silent damage when it
 * drifts, because the code keeps obeying the old measurement and nothing says so.
 *
 * 1. `packages/engine/src/config/codexNativeConfigProjection.ts:294` — the config enums the projection enforces.
 * 2. `packages/engine/packages/webview-ui/src/webview/formLogic.ts:65` — `--full-auto` is refused, so the chip list must omit it.
 * 3. `packages/engine/src/harness/HarnessManager.ts:2291` — directory trust is exact-path, and argv cannot grant it.
 * 4. `test/helpers/codexMemory.ts` — `--disable memories` suppresses native memory.
 *
 * ## Rules this command obeys
 *
 * - It never blocks. Every verdict exits 0. A `changed` line is a fact for a human to act on.
 * - It never installs, updates, or downgrades a CLI.
 * - It never sends a key to a runtime CLI. Dimension 3 opens a TUI and only reads the pane.
 * - It writes nothing into `~/.codex`. It uses a private `CODEX_HOME` under the temp directory and
 *   removes it. The credential is a symlink to the human's file, never a copy.
 * - It makes no model call. Dimension 3 opens a session and closes it before any prompt.
 *
 * ## Two traps this command is built around
 *
 * Without a credential, Codex shows the sign-in screen and never asks about directory trust. An
 * absent trust prompt then looks exactly like inherited trust. So dimension 3 runs a control case
 * first, and reports `not measured` unless that control reaches the ready screen.
 *
 * `granular` appears in the CLI's approval list and is absent from the product's. That is a decision,
 * not drift: the projection documents it as a TOML table that this path cannot receive. The compare
 * excludes it by name and prints why.
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_MEASURED_CLI_VERSION,
  CODEX_SANDBOX_MODES,
} from "@tachyon/engine/config/codexNativeConfigProjection.js";
import { FLAG_SUGGESTIONS } from "@tachyon/engine/webview/formLogic.js";
import {
  CODEX_MEMORY_MEASURED_VERSION,
  codexFeaturesListArgv,
  codexMemoryEffectiveState,
} from "../../test/helpers/codexMemory.js";
import { normalizeCliVersion } from "@tachyon/engine/runtime/measuredCliVersions.js";
import {
  type CodexScreen,
  type DimensionResult,
  classifyCodexScreen,
  compareVariantSets,
  fullAutoVerdict,
  parseExpectedVariants,
  summarize,
  trustVerdict,
} from "./runtime-remeasure-analysis.js";

const EVIDENCE_DIR = path.resolve(".tachyon/evidence/runtime-remeasure");
const REAL_CODEX_HOME = path.join(os.homedir(), ".codex");
/** A value no enum can hold. The CLI answers an invalid value with its own list. */
const INVALID = "tachyon-remeasure-probe";
/** `granular` is a TOML table in the config schema, so this scalar path can never receive it. */
const NON_SCALAR_APPROVALS = ["granular"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function have(cmd: string, args: string[]): boolean {
  try { execFileSync(cmd, args, { stdio: "pipe", timeout: 15_000 }); return true; } catch { return false; }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }

/** Run codex with a private home. No probe ever reads or writes the human's config. */
function codex(args: string[], home: string, cwd?: string): Run {
  const result = spawnSync("codex", args, {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Digest one file, or report it as absent. Used to prove the human's home did not change. */
function digest(file: string): string {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16); }
  catch { return "absent"; }
}

// ---------------------------------------------------------------------------
// dimension 1 — the config enums the projection enforces
// ---------------------------------------------------------------------------

function measureConfigEnums(home: string, installed: string): DimensionResult {
  const cases: Array<{ id: string; title: string; field: string; recorded: readonly string[]; excluded: string[] }> = [
    { id: "codex-approval-enum", title: "codex approval_policy values", field: "approval_policy", recorded: CODEX_APPROVAL_POLICIES, excluded: NON_SCALAR_APPROVALS },
    { id: "codex-sandbox-enum", title: "codex sandbox_mode values", field: "sandbox_mode", recorded: CODEX_SANDBOX_MODES, excluded: [] },
  ];
  const measured = cases.map((c) => {
    const run = codex([`-c`, `${c.field}=${INVALID}`, ...codexFeaturesListArgv()], home);
    const observed = parseExpectedVariants(`${run.stderr}\n${run.stdout}`);
    const compared = compareVariantSets(c.recorded, observed, c.excluded);
    const excludedSeen = observed.filter((v) => c.excluded.includes(v));
    const notes = [
      compared.missing.length > 0 ? `the CLI no longer accepts: ${compared.missing.join(", ")}` : "",
      compared.added.length > 0 ? `the CLI accepts values the projection refuses: ${compared.added.join(", ")}` : "",
      compared.verdict === "not-measured" ? `the CLI printed no value list (exit ${run.status}).` : "",
    ].filter(Boolean);
    return {
      id: c.id,
      title: c.title,
      anchor: "packages/engine/src/config/codexNativeConfigProjection.ts:294",
      recordedVersion: CODEX_MEASURED_CLI_VERSION,
      recorded: c.recorded.join(", "),
      observed: observed.length > 0 ? observed.join(", ") : `(none; exit ${run.status})`,
      verdict: compared.verdict,
      reason: notes.length > 0
        ? notes.join("; ")
        : excludedSeen.length > 0
          ? `installed ${installed}; \`${excludedSeen.join(", ")}\` excluded on purpose: a TOML table, not a scalar.`
          : undefined,
    };
  });
  const verdict = measured.some((entry) => entry.verdict === "changed")
    ? "changed"
    : measured.some((entry) => entry.verdict === "not-measured")
      ? "not-measured"
      : "holds";
  return {
    id: "codex-config-enums",
    title: "codex config rejection enums",
    anchor: "packages/engine/src/config/codexNativeConfigProjection.ts:294",
    recordedVersion: CODEX_MEASURED_CLI_VERSION,
    recorded: measured.map((entry) => `${entry.title.replace("codex ", "")}: ${entry.recorded}`).join("; "),
    observed: measured.map((entry) => `${entry.title.replace("codex ", "")}: ${entry.observed}`).join("; "),
    verdict,
    reason: measured.map((entry) => entry.reason).filter(Boolean).join("; ") || `installed ${installed}`,
  };
}

// ---------------------------------------------------------------------------
// dimension 2 — `--full-auto`
// ---------------------------------------------------------------------------

function measureFullAuto(home: string): DimensionResult {
  const run = codex(["--full-auto", "--help"], home);
  const text = `${run.stderr}\n${run.stdout}`;
  const rejected = /unexpected argument '--full-auto'/.test(text);
  const accepted = run.status === 0 && /Usage: codex/.test(text);
  const offered = (FLAG_SUGGESTIONS.codex ?? []).includes("--full-auto");
  if (!rejected && !accepted) {
    return {
      id: "codex-full-auto",
      title: "codex refuses --full-auto",
      anchor: "packages/engine/packages/webview-ui/src/webview/formLogic.ts:65",
      recordedVersion: "codex-cli 0.146.0",
      recorded: "rejected; the chip list omits it",
      observed: `neither refusal nor help (exit ${run.status})`,
      verdict: "not-measured",
      reason: "the CLI answered with a third shape. Read the evidence file before trusting either verdict.",
    };
  }
  const decided = fullAutoVerdict(rejected, offered);
  return {
    id: "codex-full-auto",
    title: "codex refuses --full-auto",
    anchor: "packages/engine/packages/webview-ui/src/webview/formLogic.ts:65",
    recordedVersion: "codex-cli 0.146.0",
    recorded: "rejected; the chip list omits it",
    observed: `${rejected ? "rejected: unexpected argument" : "accepted: help printed"}; chip list ${offered ? "offers it" : "omits it"}`,
    verdict: decided.verdict,
    reason: decided.reason,
  };
}

// ---------------------------------------------------------------------------
// dimension 4 — native memory
// ---------------------------------------------------------------------------

function measureMemory(base: string): DimensionResult {
  const home = path.join(base, "memory-home");
  fs.mkdirSync(home, { recursive: true });
  const state = (args: string[]): string => codexMemoryEffectiveState(codex(args, home).stdout);

  const byDefault = state(codexFeaturesListArgv());
  const enableFlag = state(["--enable", "memories", ...codexFeaturesListArgv()]);
  const disableFlag = state(["--disable", "memories", ...codexFeaturesListArgv()]);
  return {
    id: "codex-memory",
    title: "codex native memory suppression",
    anchor: "test/helpers/codexMemory.ts",
    recordedVersion: `codex-cli ${CODEX_MEMORY_MEASURED_VERSION}`,
    recorded: "--disable memories suppresses an otherwise injected planted marker",
    observed: `control only: default ${byDefault}; --enable ${enableFlag}; --disable ${disableFlag}`,
    verdict: "not-measured",
    reason:
      "the free runtime-status command proves the control moves, not that memory stops reaching the model. "
      + "Re-measuring suppression needs two authenticated, billable `codex exec` turns against the same planted store; this non-billable command does not silently spend the operator's quota.",
  };
}

// ---------------------------------------------------------------------------
// dimension 3 — directory trust
// ---------------------------------------------------------------------------

interface TmuxCase { readonly name: string; readonly cwd: string; readonly command: string }

/**
 * Open one Codex TUI in a private tmux server and read the screen it settles on.
 *
 * This function sends no key. It waits for a screen it can name, then kills the session. The
 * private `TMUX_TMPDIR` keeps this off the tmux server that runs the fleet.
 */
async function readCodexScreen(tmuxTmpdir: string, probe: TmuxCase): Promise<{ screen: CodexScreen; pane: string }> {
  const env = { ...process.env, TMUX_TMPDIR: tmuxTmpdir, TMUX: undefined, TMUX_PANE: undefined };
  const tmux = (args: string[]): string => {
    const r = spawnSync("tmux", args, { env, encoding: "utf8", timeout: 20_000 });
    return r.stdout ?? "";
  };
  tmux(["kill-session", "-t", probe.name]);
  tmux(["new-session", "-d", "-s", probe.name, "-x", "120", "-y", "40", "-c", probe.cwd, probe.command]);
  let pane = "";
  let screen: CodexScreen = "unknown";
  for (let i = 0; i < 25; i++) {
    await sleep(1_000);
    pane = tmux(["capture-pane", "-p", "-t", probe.name]);
    screen = classifyCodexScreen(pane);
    if (screen !== "unknown") break;
  }
  tmux(["kill-session", "-t", probe.name]);
  return { screen, pane };
}

async function measureTrust(base: string): Promise<DimensionResult> {
  const result = (verdict: DimensionResult["verdict"], observed: string, reason?: string): DimensionResult => ({
    id: "codex-directory-trust",
    title: "codex directory trust is exact-path",
    anchor: "packages/engine/src/harness/HarnessManager.ts:2291",
    recordedVersion: "codex-cli 0.146.0",
    recorded: "a child of a trusted directory still asks; argv `-c` cannot grant trust",
    observed,
    verdict,
    reason,
  });

  if (!have("tmux", ["-V"])) {
    return result("not-measured", "no tmux", "this dimension needs a TUI pane, and tmux is not on this host.");
  }
  const realAuth = path.join(REAL_CODEX_HOME, "auth.json");
  if (!fs.existsSync(realAuth)) {
    return result("not-measured", "no credential", "codex has no credential, so the sign-in screen precedes the trust prompt. Run `codex login`.");
  }

  const home = path.join(base, "trust-home");
  const parent = path.join(base, "trust", "parent");
  const child = path.join(parent, "child");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  // The credential is a symlink, exactly as HarnessManager materializes it. Nothing is copied.
  fs.symlinkSync(realAuth, path.join(home, "auth.json"));
  fs.writeFileSync(
    path.join(home, "config.toml"),
    `[projects.${JSON.stringify(parent)}]\ntrust_level = "trusted"\n`,
  );
  const tmuxTmpdir = path.join(base, "tmux");
  fs.mkdirSync(tmuxTmpdir, { recursive: true, mode: 0o700 });

  const launch = `CODEX_HOME=${shellQuote(home)} codex`;
  const cases: Array<{ key: keyof TrustCaseScreens; probe: TmuxCase }> = [
    { key: "exact", probe: { name: "remeasure-trust-exact", cwd: parent, command: launch } },
    { key: "child", probe: { name: "remeasure-trust-child", cwd: child, command: launch } },
    {
      key: "argv",
      probe: {
        name: "remeasure-trust-argv",
        cwd: child,
        command: `${launch} -c ${shellQuote(`projects.${JSON.stringify(child)}.trust_level="trusted"`)}`,
      },
    },
  ];

  const screens: Partial<TrustCaseScreens> = {};
  try {
    for (const c of cases) {
      const read = await readCodexScreen(tmuxTmpdir, c.probe);
      screens[c.key] = read.screen;
      fs.writeFileSync(path.join(EVIDENCE_DIR, `trust-${c.key}.pane.txt`), read.pane);
      console.log(`  trust case '${c.key}' -> ${read.screen}`);
    }
  } finally {
    // TMUX and TMUX_PANE MUST be cleared here, exactly as readCodexScreen does. This script runs
    // inside a fleet pane, so `process.env.TMUX` names the fleet socket, and tmux resolves a client
    // through TMUX before it ever looks at TMUX_TMPDIR. Spreading process.env without clearing them
    // sends this kill-server to the fleet server instead of the private one. Measured on 2026-08-06:
    // it killed the whole fleet three times (t-9713ff).
    spawnSync("tmux", ["kill-server"], {
      env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir, TMUX: undefined, TMUX_PANE: undefined },
      timeout: 20_000,
    });
  }

  const full = { exact: screens.exact ?? "unknown", child: screens.child ?? "unknown", argv: screens.argv ?? "unknown" };
  const decided = trustVerdict(full);
  return result(
    decided.verdict,
    `exact=${full.exact}; child=${full.child}; argv=${full.argv}`,
    decided.reason,
  );
}

interface TrustCaseScreens { exact: CodexScreen; child: CodexScreen; argv: CodexScreen }

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function print(results: DimensionResult[], installed: string): void {
  const mark: Record<DimensionResult["verdict"], string> = {
    holds: "HOLDS",
    changed: "CHANGED",
    "not-measured": "NOT MEASURED",
  };
  for (const r of results) {
    console.log("");
    console.log(`${mark[r.verdict].padEnd(13)} ${r.title}`);
    console.log(`              anchor   ${r.anchor}`);
    console.log(`              recorded ${r.recorded}  (on ${r.recordedVersion})`);
    console.log(`              observed ${r.observed}  (on codex-cli ${installed})`);
    if (r.reason) console.log(`              note     ${r.reason}`);
  }
  const totals = summarize(results);
  console.log("");
  console.log(`${results.length} dimensions: ${totals.holds} hold, ${totals.changed} changed, ${totals["not-measured"]} not measured.`);
  console.log("This command never blocks. A CHANGED line is a fact for a human to act on.");
}

function unavailableResults(reason: string): DimensionResult[] {
  const unavailable = (result: Omit<DimensionResult, "observed" | "verdict" | "reason">): DimensionResult => ({
    ...result,
    observed: "not measured",
    verdict: "not-measured",
    reason,
  });
  return [
    unavailable({
      id: "codex-config-enums",
      title: "codex config rejection enums",
      anchor: "packages/engine/src/config/codexNativeConfigProjection.ts:294",
      recordedVersion: CODEX_MEASURED_CLI_VERSION,
      recorded: `approval_policy values: ${CODEX_APPROVAL_POLICIES.join(", ")}; sandbox_mode values: ${CODEX_SANDBOX_MODES.join(", ")}`,
    }),
    unavailable({
      id: "codex-full-auto",
      title: "codex refuses --full-auto",
      anchor: "packages/engine/packages/webview-ui/src/webview/formLogic.ts:65",
      recordedVersion: "codex-cli 0.146.0",
      recorded: "rejected; the chip list omits it",
    }),
    unavailable({
      id: "codex-directory-trust",
      title: "codex directory trust is exact-path",
      anchor: "packages/engine/src/harness/HarnessManager.ts:2291",
      recordedVersion: "codex-cli 0.146.0",
      recorded: "a child of a trusted directory still asks; argv `-c` cannot grant trust",
    }),
    unavailable({
      id: "codex-memory",
      title: "codex native memory suppression",
      anchor: "test/helpers/codexMemory.ts",
      recordedVersion: `codex-cli ${CODEX_MEMORY_MEASURED_VERSION}`,
      recorded: "--disable memories suppresses an otherwise injected planted marker",
    }),
  ];
}

async function main(): Promise<number> {
  if (!have("codex", ["--version"])) {
    print(unavailableResults("the codex binary is unavailable on PATH."), "unavailable");
    return 0;
  }
  const installed = normalizeCliVersion(
    spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "",
  ) ?? "unknown";

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remeasure-"));
  const probeHome = path.join(base, "probe-home");
  fs.mkdirSync(probeHome, { recursive: true });

  // The human's own home must be byte-identical afterwards. This is asserted, not assumed.
  const before = { config: digest(path.join(REAL_CODEX_HOME, "config.toml")), auth: digest(path.join(REAL_CODEX_HOME, "auth.json")) };

  console.log(`runtime remeasure — codex-cli ${installed} on PATH`);

  const results: DimensionResult[] = [];
  try {
    results.push(measureConfigEnums(probeHome, installed));
    results.push(measureFullAuto(probeHome));
    results.push(await measureTrust(base));
    results.push(measureMemory(base));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  const after = { config: digest(path.join(REAL_CODEX_HOME, "config.toml")), auth: digest(path.join(REAL_CODEX_HOME, "auth.json")) };
  const homeUntouched = before.config === after.config && before.auth === after.auth;

  print(results, installed);
  console.log(homeUntouched
    ? "~/.codex is unchanged: config and credential digests match."
    : "WARNING: ~/.codex changed during this run. Inspect it before you trust the numbers above.");

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, "results.json"),
    `${JSON.stringify({ installed, results, humanHome: { before, after, unchanged: homeUntouched } }, null, 2)}\n`,
  );
  console.log(`evidence: ${path.relative(process.cwd(), EVIDENCE_DIR)}`);
  return 0;
}

main().then((code) => process.exit(code), (error) => { console.error("DOGFOOD ERROR", error); process.exit(1); });
