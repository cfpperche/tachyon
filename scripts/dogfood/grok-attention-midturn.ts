/**
 * t-d2a4dc — the two evidence gaps the `t-aafa10` verdict left open, measured against a REAL
 * canonical Grok agent: the pane while a turn is actually streaming, and a tool-authorization
 * prompt end to end.
 *
 * Why a canonical session and not a bare `grok` in tmux: both questions are about the PROJECTION.
 * `t-4e6ba5` already measured the authorization modal on an ad-hoc pane under
 * `--permission-mode default`; what is unmeasured is whether a canonical profile — which since
 * `t-26f508` projects a permission family into the private home — still ASKS. A canonical agent that
 * silently stopped asking would be more permissive than the pane it was measured on, and nothing
 * would have said so. So this drives `Workspace` → `AgentManager.spawn`, which materializes the
 * private home, the projected config and the copied credential exactly as production does.
 *
 * It costs real model calls. Prompts are deliberately small.
 *
 * SAFETY, measured and non-negotiable (from `src/attention/manifests/grok.json`): at the
 * authorization modal the highlighted option is SESSION STATE, not a constant — a first prompt
 * highlights "always-approve". A bare Enter therefore sends an unpredictable decision and on a first
 * prompt that decision is BLANKET APPROVAL. This script never sends Enter at a modal; it answers
 * with an explicit digit.
 *
 * Run: node scripts/dogfood/run.mjs grok-attention-midturn
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { TmuxService, defaultExecutor } from "@tachyon/engine/tmux/TmuxService.js";
import { AttentionMonitor, type AttentionSettings } from "@tachyon/shared/attention/AttentionMonitor.js";
import { writeSavedAgent, savedAgentSecrets, savedAgentsYaml } from "../../test/helpers/savedAgentFixture.js";

const AGENT = "grokProbe";
const EVIDENCE_DIR = path.resolve(".tachyon/evidence/grok-attention-midturn");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function have(cmd: string, args: string[]): boolean {
  try { execFileSync(cmd, args, { stdio: "pipe", timeout: 8_000 }); return true; } catch { return false; }
}
function skip(reason: string): never {
  console.log(`DOGFOOD SKIP — ${reason}`);
  process.exit(2);
}
if (!have("grok", ["--version"])) skip("grok is not installed on this host, so nothing was measured.");
if (!have("tmux", ["-V"])) skip("tmux is not available, so no pane could be driven.");
const REAL_AUTH = path.join(os.homedir(), ".grok", "auth.json");
if (!fs.existsSync(REAL_AUTH)) skip("no Grok credential — run `grok login` first (t-de73e0).");

/** The credential must be byte-identical afterwards. t-de73e0 is why this is asserted, not assumed. */
const authDigest = (): string =>
  crypto.createHash("sha256").update(fs.readFileSync(REAL_AUTH)).digest("hex");
const AUTH_BEFORE = authDigest();

/** Same minimal EngineHost the Grok continuation dogfood uses (test/integration). */
class Host {
  readonly secrets = new Map<string, string>();
  private readonly state = new Map<string, unknown>();
  constructor(private readonly storageDir: string) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  notify(): void {}
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(): Promise<unknown> { return Promise.resolve(undefined); }
  watch(): { dispose(): void } { return { dispose(): void {} }; }
  globalStoragePath(): string { return this.storageDir; }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
  getState<T>(key: string): T | undefined { return this.state.get(key) as T | undefined; }
  setState(key: string, value: unknown): void { this.state.set(key, value); }
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  t(m: string): string { return m; }
  appVersion(): string { return "0.0.0-dogfood"; }
  mediaPath(...s: string[]): string { return path.join(this.storageDir, ...s); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(): void {}
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-midturn-"));
const workspace = path.join(base, "ws");
const outside = path.join(base, "outside");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "target.txt"), "probe payload\n");
process.env.TMUX_TMPDIR = path.join(base, "t");
fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 });
delete process.env.TMUX; delete process.env.TMUX_PANE;

const fixture = writeSavedAgent(workspace, AGENT, { runtime: "grok", autostart: false, attention: { enabled: true } });
fs.writeFileSync(
  path.join(workspace, "tachyon.yml"),
  `settings:\n  maxAgents: 4\n${savedAgentsYaml([fixture])}`,
);
execFileSync("git", ["init", "-q", "-b", "main", workspace], { stdio: "ignore" });
execFileSync("git", ["-C", workspace, "commit", "-q", "--allow-empty", "-m", "root"], {
  stdio: "ignore",
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
});

const host = new Host(path.join(base, "storage"));
for (const [k, v] of savedAgentSecrets(workspace, [fixture])) host.secrets.set(k, v);

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };
const evidence: Record<string, unknown>[] = [];
const record = (phase: string, data: Record<string, unknown>) => {
  evidence.push({ phase, ...data });
  console.log(`[${phase}] ${JSON.stringify(data)}`);
};

async function main(): Promise<number> {
  const tmux = new TmuxService(defaultExecutor);
  const ws = await Workspace.createForTest(
    workspace,
    { host: host as never, onViewsChanged: () => {} },
    { tmux, startBridge: false },
  );
  await ws.manager.spawn(AGENT);
  const session = ws.manager.session(AGENT);
  // Drive the pane through the SERVICE, not raw tmux: it owns the socket, and a raw call that
  // silently fails to connect returns "" — which the monitor happily classifies as a state. An
  // earlier run of this script did exactly that and reported a confident "working" from nothing.
  const tmuxCapAsync = async (escaped: boolean, lines: number): Promise<string> =>
    tmux.capturePane(session, escaped ? { lines, escaped: true } : lines);
  let lastPane = "";
  const tmuxCap = (_escaped: boolean, _lines: number): string => lastPane;
  const refresh = async (lines = 60): Promise<string> => { lastPane = await tmuxCapAsync(false, lines); return lastPane; };
  const send = async (text: string) => { await tmux.sendKeys(session, text, false); };
  const submit = async () => { await tmux.sendKeys(session, "", true); };

  /** The REAL detector, reading this pane exactly as production reads an agent's. */
  let clock = 1_000_000;
  const monitor = new AttentionMonitor({
    runningAgents: async () => [AGENT],
    capturePane: async () => tmuxCapAsync(false, 60),
    capturePaneEscaped: async (_a, lines) => tmuxCapAsync(true, lines),
    cpuTicks: async () => null,
    settingsOf: () => SETTINGS,
    cmdOf: () => "grok",
    now: () => clock,
  });
  const classify = async () => { await monitor.tick(); clock += 1_500; return monitor.stateOf(AGENT); };

  // The private home the canonical spawn materialized — proof the projection, not ~/.grok, is live.
  const privateHome = path.join(workspace, ".tachyon", "bridge-mcp", `${AGENT}.grok`);
  const privateAuth = path.join(privateHome, "auth.json");
  record("projection", {
    privateHomeExists: fs.existsSync(privateHome),
    authIsRegularFileNotSymlink: fs.existsSync(privateAuth) && fs.lstatSync(privateAuth).isFile() && !fs.lstatSync(privateAuth).isSymbolicLink(),
    configProjected: fs.existsSync(path.join(privateHome, "config.toml")),
  });

  await sleep(15_000); // TUI settle
  record("idle-before", { state: (await classify())?.state, composerOccupied: (await classify())?.composerOccupied });

  const ONLY_AUTH = process.env.GROK_DOGFOOD_PHASE === "tool-auth";
  // ---------- (1) MID-TURN ----------
  if (!ONLY_AUTH) {
  await send("Print the numbers 1 to 40, one per line, each with a three-word clause.");
  await sleep(1_000);
  await submit();
  const midTurn: Array<Record<string, unknown>> = [];
  let midTurnCapture = "";
  for (let i = 0; i < 20; i++) {
    await sleep(900);
    const st = await classify();
    const pane = await refresh(12);
    const streaming = /\d+\s*\|\s|esc to interrupt|Thinking|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/i.test(pane);
    midTurn.push({ t: i, state: st?.state, composerOccupied: st?.composerOccupied, streamingGlyph: streaming });
    if (streaming && !midTurnCapture) midTurnCapture = await refresh(20);
  }
  const sawWorking = midTurn.some((m) => m.state === "working");
  const occupiedDuringTurn = midTurn.filter((m) => m.composerOccupied === true).length;
  record("mid-turn", { samples: midTurn.length, sawWorkingState: sawWorking, samplesWithComposerOccupied: occupiedDuringTurn, capturedStreamingPane: midTurnCapture.length > 0 });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  if (midTurnCapture) fs.writeFileSync(path.join(EVIDENCE_DIR, "mid-turn.pane.txt"), midTurnCapture);

  await sleep(20_000); // let the turn finish
  } // end mid-turn phase
  record("idle-after-turn", { state: (await classify())?.state, composerOccupied: (await classify())?.composerOccupied });

  // ---------- (2) TOOL AUTHORIZATION, END TO END ----------
  // t-4e6ba5 measured the modal by asking for a DELETE outside the workspace. A read was tried first
  // here and produced no prompt at all, so the trigger is matched to the one with evidence behind it.
  // The target is this script's own throwaway file.
  await send(`Run the shell command: rm -f ${path.join(outside, "target.txt")}`);
  await sleep(1_000);
  await submit();
  let needsInputAt = -1;
  let modalCapture = "";
  for (let i = 0; i < 25; i++) {
    await sleep(1_000);
    const st = await classify();
    // The manifest's state string is "needs-input". An earlier run of this script checked for
    // "needs" and reported a confident FALSE NEGATIVE against a modal that was plainly on screen —
    // the detector was right and the harness was wrong. Assert the value the product actually uses.
    if (st?.state === "needs-input") {
      needsInputAt = i;
      modalCapture = await refresh(14);
      break;
    }
  }
  // A negative is a result and needs bytes behind it: capture regardless, so "no modal" can be told
  // apart from "the agent never attempted the command".
  const toolAuthPane = modalCapture || await refresh(24);
  fs.writeFileSync(path.join(EVIDENCE_DIR, "tool-auth.pane.txt"), toolAuthPane);
  record("tool-auth-detect", {
    needsInputAfterSeconds: needsInputAt,
    detected: needsInputAt >= 0,
    paneShowsModalChrome: /\d+\/\d+:select|always-approve|\d\s*\([●○]\)/.test(toolAuthPane),
    targetStillExists: fs.existsSync(path.join(outside, "target.txt")),
  });

  let continued = false;
  if (needsInputAt >= 0) {
    // NEVER Enter — the highlighted option is session state and a first prompt highlights
    // always-approve. "2" is the measured "Yes, proceed" one-time grant.
    await send("2");
    await sleep(6_000);
    const after = await refresh(24);
    continued = /probe payload/.test(after) || !/\d+\/\d+:select/.test(after);
    fs.writeFileSync(path.join(EVIDENCE_DIR, "tool-auth-after.pane.txt"), after);
    record("tool-auth-answer", { answered: "2", modalDismissed: !/\d+\/\d+:select/.test(after), turnContinued: continued });
  }

  await ws.manager.kill(AGENT).catch(() => undefined);
  ws.dispose();

  const authAfter = authDigest();
  record("credential-integrity", { unchanged: authAfter === AUTH_BEFORE, before: AUTH_BEFORE.slice(0, 16), after: authAfter.slice(0, 16) });
  fs.writeFileSync(path.join(EVIDENCE_DIR, "evidence.json"), JSON.stringify(evidence, null, 2));

  const ok = authAfter === AUTH_BEFORE;
  console.log(ok ? "\nDOGFOOD COMPLETE — see evidence.json; negative results are results." : "\nDOGFOOD FAILED — credential changed, investigate before rerunning.");
  return ok ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error("DOGFOOD ERROR", e); process.exit(1); });
