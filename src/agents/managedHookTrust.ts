/**
 * t-bc8d21 — scoped trust levers for hooks that Tachyon itself materializes/injects.
 *
 * Boundary: only when `proof.injected` is true (Tachyon authored the injection). Never widen
 * general tool/sandbox permissions. Runtimes without a scoped lever fail closed when injection
 * is claimed — silent global YOLO is forbidden.
 */

import { codexFlagCmd } from "../config/loadConfig.js";

/** Codex CLI: skip persisted hook-trust for this invocation only (not permanent blanket trust). */
export const CODEX_MANAGED_HOOK_TRUST_BYPASS_FLAG = "--dangerously-bypass-hook-trust";

export type ManagedHookRuntime = "claude" | "codex" | "grok" | "hermes" | "opencode" | "generic";

/** How Tachyon proved authorship of the hooks for this spawn. */
export type ManagedHookInjectionKind =
  | "session-settings" // Claude `--settings` SessionStart/Stop
  | "session-config-flag" // Codex `-c hooks.SessionStart=…` / `hooks.Stop=…`
  | "private-home-hooks" // Grok `$GROK_HOME/hooks/*.json` (folder-trust seed is separate)
  | "none";

export interface ManagedHookProof {
  /** True only when Tachyon's materialize/inject path returned managed hook config. */
  injected: boolean;
  kind: ManagedHookInjectionKind;
  runtime: ManagedHookRuntime;
}

export class ManagedHookTrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedHookTrustError";
  }
}

/**
 * Apply the runtime-scoped lever so Tachyon-managed hooks do not re-prompt for trust.
 *
 * - `injected: false` → no-op (never adds flags).
 * - Claude / Grok with injection → no argv change (Claude has no hook-hash gate; Grok uses
 *   folder-trust seed at GROK_HOME materialize, not this helper).
 * - Codex with injection → `--dangerously-bypass-hook-trust`.
 * - Hermes / OpenCode / unknown with injection → fail closed (no scoped lever wired yet).
 */
export function applyManagedHookTrust(cmd: string, proof: ManagedHookProof): string {
  if (!proof.injected) return cmd;

  switch (proof.runtime) {
    case "codex":
      if (proof.kind !== "session-config-flag" && proof.kind !== "none") {
        // Allow session-config-flag; "none" would be inconsistent with injected:true but still apply
        // the Codex lever if somehow claimed — require config-flag for clarity.
      }
      if (proof.kind !== "session-config-flag") {
        throw new ManagedHookTrustError(
          `codex managed-hook trust requires kind 'session-config-flag' (got '${proof.kind}')`,
        );
      }
      return codexFlagCmd(cmd, CODEX_MANAGED_HOOK_TRUST_BYPASS_FLAG);

    case "claude":
      // Additive `--settings` hooks do not use a Codex-style hook-trust ledger. Folder trust is
      // seeded separately (hasTrustDialogAccepted). Do not add --dangerously-skip-permissions here.
      if (proof.kind !== "session-settings") {
        throw new ManagedHookTrustError(
          `claude managed-hook trust requires kind 'session-settings' (got '${proof.kind}')`,
        );
      }
      return cmd;

    case "grok":
      // Private-home hooks are gated by folder trust, seeded at GROK_HOME materialize
      // (seedGrokTrustedFolders). No per-invocation argv bypass for hook hashes.
      if (proof.kind !== "private-home-hooks") {
        throw new ManagedHookTrustError(
          `grok managed-hook trust requires kind 'private-home-hooks' (got '${proof.kind}')`,
        );
      }
      return cmd;

    case "hermes":
      throw new ManagedHookTrustError(
        "runtime 'hermes' has no scoped managed-hook trust adapter yet " +
          "(use --accept-hooks only when Tachyon injects Hermes hooks); refusing silent global bypass",
      );

    case "opencode":
      throw new ManagedHookTrustError(
        "runtime 'opencode' has no Tachyon lifecycle-hook injection and no scoped hook-trust lever; " +
          "refusing to treat --auto / tool permissions as hook-trust bypass",
      );

    default:
      throw new ManagedHookTrustError(
        `runtime '${proof.runtime}' has no managed-hook trust adapter; refusing silent global bypass`,
      );
  }
}

/** Map a spawn binary name to the managed-hook runtime id (unknown → generic). */
export function managedHookRuntimeOf(binary: string): ManagedHookRuntime {
  switch (binary) {
    case "claude":
    case "codex":
    case "grok":
    case "hermes":
    case "opencode":
      return binary;
    default:
      return "generic";
  }
}
