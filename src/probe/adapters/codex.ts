/**
 * Spec 257 (D5) — the codex headless-capture adapter. codex `exec --output-last-message <file>` writes
 * the final message to a FILE (the artifact we read, never the noisy stdout), with `--json` events on
 * stdout. codex has no structured budget/refusal subtype in v1, so those native distinctions don't
 * exist here — an honest mapping: clean artifact → ok; nonzero-with-artifact → model_error; nonzero-
 * without → process_error; clean-but-empty → empty_output. Wall-clock timeout/cancel are the runner's
 * job (D6), never the adapter's.
 *
 * Exact flags are localized here (pin at impl time, capability-probe rather than freeze).
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ProbeResult, TerminationReason } from "../taxonomy.js";
import type { CapabilityReport, HeadlessCaptureAdapter, Invocation, ProbeSpec, RawOutcome } from "./types.js";

const execFileP = promisify(execFile);
const ADAPTER_VERSION = "1";

function sandboxFlag(spec: ProbeSpec): string[] {
  // OQ6 — neutral intent mapped to codex's own sandbox vocabulary (runtime-native, advisory).
  return ["--sandbox", spec.sandbox === "workspace-write" ? "workspace-write" : "read-only"];
}

export interface CodexAdapterDeps {
  versionProbe?: () => Promise<string | null>;
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

  return {
    runtime: "codex",
    adapterVersion: ADAPTER_VERSION,

    buildInvocation(spec: ProbeSpec, scratchDir: string): Invocation {
      const resultArtifact = path.join(scratchDir, "codex-last-message.txt");
      const args = ["exec", "--output-last-message", resultArtifact, "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", ...sandboxFlag(spec)];
      if (spec.model) args.push("--model", spec.model);
      args.push(spec.prompt);
      return { cmd: "codex", args, cwd: spec.cwd, resultArtifact };
    },

    interpret(raw: RawOutcome): ProbeResult {
      const native = { runtime: "codex" };
      const answer = (raw.resultArtifactText ?? "").trim();
      if (raw.exitCode === 0) {
        return answer ? base("ok", answer, raw, native) : base("empty_output", "", raw, native);
      }
      // nonzero: an artifact with content is a model-level error result; otherwise a process failure.
      const reason: TerminationReason = answer ? "model_error" : "process_error";
      const msg = answer || raw.stderr.trim() || "codex exec exited non-zero";
      return base(reason, msg, raw, native);
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
