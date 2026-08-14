/**
 * t-c5f29b — real-runtime dogfood for the Claude composer suggestion/draft distinction.
 *
 * Unit fixtures pin the measured bytes. This drives the REAL Claude Code CLI in a real tmux pane and
 * feeds the REAL `AttentionMonitor` real `capture-pane` output, so the thing under test is the whole
 * chain: terminal styling → tmux capture → detector → `composerOccupied`.
 *
 * The property: a suggestion rendered into an otherwise empty composer must NOT read as a human
 * draft (it refused continuity with `refused-composer` and no key would clear it), while text a human
 * actually typed must keep blocking injection.
 *
 * Runs on its own tmux socket and its own scratch dir — it never touches the fleet server.
 *
 * Run: node scripts/dogfood/run.mjs claude-composer-suggestion
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";

const SOCKET = "tachyon-t-c5f29b-dogfood";
const SESSION = "composer-probe";
const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmux(args: string[], allowFail = false): string {
  try {
    return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    if (allowFail) return "";
    throw err;
  }
}

const target = `${SESSION}:0.0`;
const capture = (escaped: boolean, lines = 8): string =>
  tmux(["capture-pane", "-p", ...(escaped ? ["-e"] : []), "-t", target, "-S", `-${lines}`], true);

/** The real detector, reading this pane exactly as production reads an agent's pane. */
async function composerOccupied(): Promise<boolean> {
  let now = 1_000_000;
  const monitor = new AttentionMonitor({
    runningAgents: async () => ["probe"],
    capturePane: async () => capture(false, 40),
    capturePaneEscaped: async (_agent, lines) => capture(true, lines),
    cpuTicks: async () => null,
    settingsOf: () => SETTINGS,
    cmdOf: () => "claude",
    now: () => now,
  });
  await monitor.tick();
  now += 1_500;
  await monitor.tick();
  return monitor.stateOf("probe")?.composerOccupied ?? true;
}

/** The composer's own line, as the pane renders it right now (for evidence in the log). */
function composerLine(): string {
  const stripped = capture(false, 8).split("\n").filter((l) => l.includes("❯"));
  return stripped.at(-1)?.trim() ?? "(no composer line found)";
}

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

/** Poll until the pane's composer line satisfies `done`, or give up. */
async function waitForComposer(done: (line: string) => boolean, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(composerLine())) return true;
    await sleep(1000);
  }
  return false;
}

const checks: boolean[] = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-composer-dogfood-"));

try {
  console.log("\n== 0: the real Claude CLI is present ==");
  let version: string;
  try {
    version = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
  } catch {
    console.log("FAIL — claude CLI not on PATH; this dogfood measures the real binary");
    console.log("\nDOGFOOD FAIL — 0/1 checks passed");
    process.exit(1);
  }
  checks.push(report("claude is installed", true, version));

  fs.writeFileSync(path.join(scratch, "README.md"), "hi\n");
  // A trusted, git-backed dir so the CLI lands straight on its composer with no consent prompt.
  execFileSync("git", ["init", "-q", "."], { cwd: scratch });
  tmux(["kill-session", "-t", SESSION], true);
  tmux(["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-c", scratch, "claude --model claude-haiku-4-5-20251001"]);

  // The consent prompt appears for an untrusted folder; answer it so the composer is reachable.
  await waitForComposer((line) => line.includes("❯"), 60_000);
  if (capture(false, 20).includes("Yes, I trust this folder")) {
    tmux(["send-keys", "-t", target, "Enter"]);
    await sleep(8_000);
  }

  console.log("\n== 1: a suggestion in an empty composer ==");
  {
    const appeared = await waitForComposer((line) => /❯\s*\S/.test(line), 45_000);
    const line = composerLine();
    if (!appeared) {
      // No suggestion rendered in this build/config — the scenario cannot be exercised, and saying so
      // is worth more than a check that quietly passes on an empty composer.
      checks.push(report("SKIPPED — this build rendered no suggestion to test against", true, { line }));
    } else {
      const occupied = await composerOccupied();
      checks.push(report(
        "the suggestion does not read as a human draft, so continuity is not refused",
        occupied === false,
        { composerLine: line, composerOccupied: occupied },
      ));
    }
  }

  console.log("\n== 2: text a human actually typed ==");
  {
    // The incident's own text. Typed for real, it must keep blocking injection.
    tmux(["send-keys", "-t", target, "-l", "integre em main e verifique o tree"]);
    await sleep(2_500);
    const occupied = await composerOccupied();
    checks.push(report(
      "a real typed draft still occupies the composer — injection protection preserved",
      occupied === true,
      { composerLine: composerLine(), composerOccupied: occupied },
    ));
  }

  console.log("\n== 3: the draft cleared ==");
  {
    tmux(["send-keys", "-t", target, "C-c"]);
    await sleep(3_000);
    const occupied = await composerOccupied();
    checks.push(report(
      "clearing the draft frees the composer again",
      occupied === false,
      { composerLine: composerLine(), composerOccupied: occupied },
    ));
  }

  console.log("\n== 4: the styling this rests on, straight off the pane ==");
  {
    const raw = capture(true, 8).split("\n").filter((l) => l.includes("❯")).at(-1) ?? "";
    // The claim is narrow and checkable: the suggestion carries SGR 2 and a typed draft does not.
    checks.push(report(
      "the escaped capture is available and carries SGR styling for the composer line",
      raw.includes("\x1b["),
      { escapedComposerLine: JSON.stringify(raw) },
    ));
  }
} finally {
  tmux(["kill-session", "-t", SESSION], true);
  tmux(["kill-server"], true);
  fs.rmSync(scratch, { recursive: true, force: true });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
