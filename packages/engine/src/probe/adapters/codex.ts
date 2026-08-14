/**
 * Spec 257 (D5) — the codex headless-capture adapter. codex `exec --output-last-message <file>` writes
 * the final message to a FILE (the artifact we read, never the noisy stdout), with `--json` events on
 * stdout. codex has no structured budget/refusal subtype in v1, so those native distinctions don't
 * exist here — an honest mapping: clean artifact → ok; nonzero-with-artifact → model_error; nonzero-
 * without → process_error; clean-but-empty → empty_output. Wall-clock timeout/cancel are the runner's
 * job (D6), never the adapter's.
 *
 * SDD 476 — and the run now proves which model it ran on. `exec --json` reports no model identity, so
 * the proof comes from Codex's own session rollout, correlated to this exact run by the `thread_id`
 * the stream already emits. That rollout only exists because `--ephemeral` is gone; the isolation it
 * used to provide is now provided by a PRIVATE per-run `CODEX_HOME` under the run's scratch dir, torn
 * down by {@link HeadlessCaptureAdapter.cleanup} on every exit path. The human's `~/.codex` is
 * neither read for configuration nor written for sessions, history, caches or state.
 *
 * Exact flags are localized here (pin at impl time, capability-probe rather than freeze).
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ProbeResult, TerminationReason } from "../taxonomy.js";
import type { CapabilityReport, HeadlessCaptureAdapter, Invocation, ProbeSpec, RawOutcome } from "./types.js";
import { collectCodexSessionEvidence, prepareCodexHome, removeCodexHome, type CodexSessionEvidence } from "./codexSessionEvidence.js";

const execFileP = promisify(execFile);
const ADAPTER_VERSION = "2";

function sandboxFlag(spec: ProbeSpec): string[] {
  // OQ6 — neutral intent mapped to codex's own sandbox vocabulary (runtime-native, advisory).
  return ["--sandbox", spec.sandbox === "workspace-write" ? "workspace-write" : "read-only"];
}

/**
 * SDD 476 — a probe asks one bounded question; it has no business loading an app catalog or fetching
 * a remote plugin index. Narrowing the surface also keeps the per-run private home cheap: measured on
 * codex-cli 0.145.0, a fresh home costs 38 MB with these on and 1.2 MB with them off.
 */
const NARROW_SURFACE = ["--disable", "plugins", "--disable", "remote_plugin", "--disable", "apps", "--disable", "skill_search"];

export interface CodexAdapterDeps {
  versionProbe?: () => Promise<string | null>;
  /** SDD 476 — injectable so correlation is table-testable without spawning the real CLI. */
  collectEvidence?: (codexHome: string, stdout: string) => Promise<CodexSessionEvidence>;
  /** SDD 476 — injectable private-home lifecycle (tests point it at their own scratch). */
  prepareHome?: (scratchDir: string) => Promise<string>;
  removeHome?: (home: string | undefined) => Promise<void>;
}

export function createCodexAdapter(deps: CodexAdapterDeps = {}): HeadlessCaptureAdapter {
  const versionProbe =
    deps.versionProbe ??
    (async () => {
      try {
        const { stdout } = await execFileP("codex", ["--version"], { timeout: 10_000 });
        return stdout.trim() || "unknown";
      } catch {
        return null;
      }
    });
  const collectEvidence = deps.collectEvidence ?? collectCodexSessionEvidence;
  const prepareHome = deps.prepareHome ?? ((scratchDir: string) => prepareCodexHome(scratchDir));
  const removeHome = deps.removeHome ?? removeCodexHome;

  return {
    runtime: "codex",
    adapterVersion: ADAPTER_VERSION,
    // SDD 476 — codex proves its model from its own session record, so SDD 473 enforcement is on.
    reportsEffectiveModel: true,
    // …but that record is what codex RESOLVED and sent, not what the provider billed. It catches a
    // local substitution (profile, config layering, alias resolution) between the flag and the wire;
    // it is not provider attestation, and the stored verdict says which it is instead of implying.
    modelEvidence: "session-record",

    async buildInvocation(spec: ProbeSpec, scratchDir: string): Promise<Invocation> {
      const resultArtifact = path.join(scratchDir, "codex-last-message.txt");
      const codexHome = await prepareHome(scratchDir);
      const args = [
        "exec",
        "--output-last-message",
        resultArtifact,
        "--json",
        // `--ephemeral` is deliberately ABSENT (SDD 476): it suppressed the rollout that carries the
        // model identity. Isolation comes from the private `CODEX_HOME` below, which is stronger — it
        // relocates config, sessions, history, caches and state, not only the session file.
        "--ignore-user-config",
        "--ignore-rules",
        // t-7cc65e — a probe answers a bounded question wherever the caller happens to be, and Codex
        // otherwise refuses outright when that cwd is not a git repository: "Not inside a trusted
        // directory and --skip-git-repo-check was not specified" (exit 1, no JSON, no artifact). The
        // same question answers fine on Claude and Grok, so the refusal was pure fleet asymmetry.
        // This is not a loosening of the probe's real boundary: measured on codex-cli 0.145.0, with
        // this flag AND --sandbox read-only, a write request still comes back refused and no file is
        // created. The sandbox is the boundary; the git-repo check is about directory trust, which
        // Tachyon already answers by owning the private CODEX_HOME and its trusted-folder seed.
        "--skip-git-repo-check",
        ...NARROW_SURFACE,
        ...sandboxFlag(spec),
      ];
      if (spec.model) args.push("--model", spec.model);
      args.push(spec.prompt);
      return { cmd: "codex", args, cwd: spec.cwd, env: { CODEX_HOME: codexHome }, resultArtifact };
    },

    async interpret(raw: RawOutcome, _spec: ProbeSpec, inv: Invocation): Promise<ProbeResult> {
      // SDD 476 — the model identity lives in this run's private rollout, correlated by thread_id.
      // `unavailable` is recorded rather than swallowed, so an `unproven` run can say what was
      // missing; nothing falls back to the requested model, the newest rollout, cost or token counts.
      const evidence = inv.env?.CODEX_HOME
        ? await collectEvidence(inv.env.CODEX_HOME, raw.stdout)
        : { unavailable: "the probe ran without a private codex home, so no session could be correlated" };
      const native = {
        runtime: "codex",
        ...(evidence.sessionId ? { sessionId: evidence.sessionId } : {}),
        ...(evidence.models ? { reportedNativeModels: evidence.models } : {}),
        ...(evidence.unavailable ? { modelEvidenceUnavailable: evidence.unavailable } : {}),
      };
      const answer = (raw.resultArtifactText ?? "").trim();
      if (raw.exitCode === 0) {
        return answer ? base("ok", answer, raw, native) : base("empty_output", "", raw, native);
      }
      // nonzero: an artifact with content is a model-level error result; otherwise a process failure.
      const reason: TerminationReason = answer ? "model_error" : "process_error";
      const msg = answer || raw.stderr.trim() || "codex exec exited non-zero";
      return base(reason, msg, raw, native);
    },

    async cleanup(inv: Invocation): Promise<void> {
      await removeHome(inv.env?.CODEX_HOME);
    },

    async detectCapability(): Promise<CapabilityReport> {
      const version = await versionProbe();
      return version ? { available: true, binaryVersion: version } : { available: false, reason: "codex CLI not found on PATH" };
    },
  };
}

function base(reason: TerminationReason, lastMessage: string, raw: RawOutcome, native: ProbeResult["native"]): ProbeResult {
  return { reason, lastMessage, exitCode: raw.exitCode, timedOut: false, native };
}

/** Default adapter wired to the real `codex --version` probe. */
export const codexAdapter = createCodexAdapter();
