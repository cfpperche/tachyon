import path from "node:path";
import { spawn } from "node:child_process";
import { RUNTIME_AUTH_PREFLIGHT } from "@tachyon/shared/runtime/authRequired.js";
import {
  PREFLIGHT_TIMEOUT_MS,
  type ParsedLaunchCommand,
  type RuntimeLaunchPreflight,
  type RuntimeLaunchPreflightPort,
} from "@tachyon/shared/runtime/launchPreflight.js";

/**
 * SDD 477 / `t-0338fc` — the one runtime that fails authentication in the invisible direction.
 *
 * Every other runtime Tachyon drives says something when it cannot authenticate. OpenCode does not:
 * measured on 1.18.5 with an empty `XDG_DATA_HOME`, `opencode run 'say ok'` exits 0 and answers — on
 * the fallback model `big-pickle`, not on whatever the operator believes is running. So an agent can
 * look perfectly healthy while its answers come from a model nobody chose, and its results get
 * attributed to it anyway. There is nothing in the turn to detect, and SDD 477 forbids inventing one
 * from silence, exit code, latency or cost.
 *
 * Three candidate signals were measured before this one was chosen:
 *
 *  - `run --format json` emits `step_start`/`text`/`step_finish` and **no model field at all**. The
 *    effective model appears only in session storage (`opencode export` → `info.model.id`), which is
 *    *after* the turn has already run. Too late to be a launch gate.
 *  - An explicit `-m` pin does NOT degrade — `-m anthropic/claude-sonnet-4-5` fails outright. The
 *    silent fallback is specific to the unpinned default path, which is exactly how Tachyon launches.
 *  - `opencode models` is account-aware (7 anonymous/free slugs unauthenticated, 58 with credentials),
 *    but reading auth out of it would mean hardcoding which slugs are the free set — a derived,
 *    brittle signal for a question the CLI answers directly.
 *
 * So this asks the credential store itself. `opencode providers list` reports a positive inventory,
 * covering BOTH of OpenCode's authentication paths — the `auth.json` store and provider keys found in
 * the environment — and it is a local read: measured working from a cold private home with the
 * network black-holed, in under a second.
 *
 * What it proves is bounded and worth stating: a credential is READABLE, not that it is VALID. An
 * expired token is still an inventory entry. This gate closes the measured footgun (launching with
 * nothing at all, which is what a mis-seeded private home produces); it is not a claim that a launch
 * which passes it can never hit an auth failure later.
 */

/** `opencode providers list` is a short inventory; well past any real one, far below a memory risk. */
export const OPENCODE_PROVIDERS_MAX_BYTES = 64 * 1024;
/** A plausible inventory count is one or two digits; anything longer is a shape nobody measured. */
const MAX_COUNT_DIGITS = 6;

export interface OpencodeCredentialInventory {
  /** entries in the runtime's own credential store (`auth.json`). */
  credentials: number;
  /** provider keys the runtime recognised in the environment. */
  environment: number;
  /** the store's own summary line, verbatim after ANSI stripping — a count, never a secret. */
  reportedLine: string;
}

/** The same CSI shape the pane readers strip; the inventory is styled text, not a cursor-addressed UI. */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Parse `opencode providers list`. Returns null when the text is not a recognizable inventory, which
 * is the honest answer for an error, an unmeasured layout, or a future release that changes wording.
 *
 * Anchored on the two summary lines the CLI closes each section with:
 *
 *     ┌  Credentials /home/…/opencode/auth.json
 *     │
 *     ●  OpenCode Go api
 *     │
 *     └  1 credentials
 *
 *     ┌  Environment
 *     │
 *     ●  OpenAI OPENAI_API_KEY
 *     │
 *     └  1 environment variable
 *
 * The credentials summary is REQUIRED — without it we did not understand the output and must not
 * pretend the inventory is empty. The environment section is absent when nothing was found, so its
 * absence reads as zero, but only once the credentials line has proven the layout is the measured one.
 *
 * Counting the `●` entries instead would be the fragile choice: the provider LABELS are the part that
 * varies (a store holds `OpenAI`, `Cloudflare Workers AI`, `OpenCode Go`), while the summary line is
 * the CLI's own arithmetic. Note the measured quirk that the credentials count is always pluralized
 * ("1 credentials") while the environment one is not ("1 environment variable") — both spellings are
 * accepted rather than either being treated as the canonical form.
 */
export function parseOpencodeCredentialInventory(text: string): OpencodeCredentialInventory | null {
  let credentials: number | undefined;
  let reportedLine: string | undefined;
  let environment = 0;
  for (const raw of text.replace(ANSI_RE, "").split(/\r?\n/)) {
    const line = raw.replace(/^[\s│┌└─├]+/, "").trim();
    const credentialSummary = /^(\d+)\s+credentials?$/i.exec(line);
    if (credentialSummary) {
      // A second summary line means this is not the single-inventory output we measured.
      if (credentials !== undefined) return null;
      if (credentialSummary[1]!.length > MAX_COUNT_DIGITS) return null;
      credentials = Number.parseInt(credentialSummary[1]!, 10);
      reportedLine = line;
      continue;
    }
    const environmentSummary = /^(\d+)\s+environment variables?$/i.exec(line);
    if (environmentSummary) {
      if (environmentSummary[1]!.length > MAX_COUNT_DIGITS) return null;
      environment = Number.parseInt(environmentSummary[1]!, 10);
    }
  }
  if (credentials === undefined || reportedLine === undefined) return null;
  return { credentials, environment, reportedLine };
}

export interface OpencodeProbeResult {
  code: number | null;
  text: string;
  failure?: "timeout" | "oversized";
}

export interface OpencodeProbeOptions {
  timeoutMs?: number;
  cwd?: string;
}

export type OpencodeCredentialProbe = (
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options?: OpencodeProbeOptions,
) => Promise<OpencodeProbeResult>;

/** Run `opencode providers list` under the same env/cwd the launch would use, bounded in time and output. */
export function probeOpencodeCredentials(
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: OpencodeProbeOptions = {},
): Promise<OpencodeProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args, "providers", "list"], {
      cwd: options.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    let text = "";
    let settled = false;
    let forced: OpencodeProbeResult["failure"];
    const finish = (result: OpencodeProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const terminate = (): void => {
      child.stdout.pause();
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* fall through to the direct kill */
        }
      }
      child.kill("SIGKILL");
    };
    const force = (failure: NonNullable<OpencodeProbeResult["failure"]>): void => {
      if (forced) return;
      forced = failure;
      terminate();
    };
    const timer = setTimeout(() => force("timeout"), options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (forced) return;
      text += chunk.toString("utf8");
      if (text.length > OPENCODE_PROVIDERS_MAX_BYTES) force("oversized");
    });
    child.on("error", () => finish({ code: null, text: "", ...(forced ? { failure: forced } : {}) }));
    child.on("close", (code) => {
      if (forced) return finish({ code: null, text: "", failure: forced });
      finish({ code, text });
    });
  });
}

export class OpencodeLaunchPreflight implements RuntimeLaunchPreflightPort {
  constructor(private readonly probe: OpencodeCredentialProbe = probeOpencodeCredentials) {}

  async check(
    command: ParsedLaunchCommand,
    env: Readonly<Record<string, string | undefined>>,
    cwd?: string,
  ): Promise<RuntimeLaunchPreflight> {
    if (path.basename(command.binary) !== "opencode") {
      return { state: "unverifiable", code: "runtime_preflight_unverifiable", reason: "runtime adapter mismatch" };
    }

    const result = await this.probe(command.probeBinary, command.probeArgv, env, { cwd });
    // A probe that could not run is treated as fail-closed rather than as "probably fine". The measured
    // read is local and works offline from a cold home, so a failure here means the environment is
    // broken — and the cost of guessing wrong is the exact silent degradation this gate exists to stop.
    if (result.failure === "timeout") {
      return { state: "failed", code: "runtime_preflight_failed", runtime: "opencode", reason: "credential store probe timed out" };
    }
    if (result.failure === "oversized") {
      return { state: "failed", code: "runtime_preflight_failed", runtime: "opencode", reason: "credential store probe exceeded output limit" };
    }
    if (result.code !== 0) {
      return { state: "failed", code: "runtime_preflight_failed", runtime: "opencode", reason: "credential store probe failed" };
    }
    const inventory = parseOpencodeCredentialInventory(result.text);
    if (!inventory) {
      return {
        state: "failed",
        code: "runtime_preflight_failed",
        runtime: "opencode",
        reason: "opencode providers list reported no readable credential inventory",
      };
    }
    if (inventory.credentials === 0 && inventory.environment === 0) {
      return {
        state: "unauthenticated",
        code: "runtime_auth_unavailable",
        runtime: "opencode",
        humanAction: RUNTIME_AUTH_PREFLIGHT.opencode!.humanAction,
        reportedLine: inventory.reportedLine,
        source: "opencode-providers-list",
      };
    }
    // A readable credential is ALL this proves. OpenCode's model catalog is a separate question this
    // adapter deliberately does not answer, so the model dimension stays exactly as unverifiable as it
    // was before this adapter existed — an explicit pin still fails closed where it did before.
    return {
      state: "unverifiable",
      code: "runtime_preflight_unverifiable",
      runtime: "opencode",
      reason: "runtime exposes no authoritative model catalog adapter",
    };
  }
}
