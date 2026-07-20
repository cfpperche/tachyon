import path from "node:path";
import type {
  ParsedLaunchCommand,
  RuntimeLaunchPreflight,
  RuntimeLaunchPreflightPort,
} from "../launchPreflight.js";

/**
 * Claude exposes no bounded account-aware model catalog command. Explicit model
 * selections are therefore validated by the actual CLI during the existing
 * bounded startup-readiness phase; this adapter never labels them catalog-supported.
 */
export class ClaudeLaunchPreflight implements RuntimeLaunchPreflightPort {
  async check(
    command: ParsedLaunchCommand,
    _env: Readonly<Record<string, string | undefined>>,
    _cwd?: string,
  ): Promise<RuntimeLaunchPreflight> {
    if (path.basename(command.binary) !== "claude") {
      return {
        state: "unverifiable",
        code: "runtime_preflight_unverifiable",
        reason: "runtime adapter mismatch",
      };
    }
    if (!command.model) return { state: "supported", runtime: "claude", source: "default-model" };
    return {
      state: "provisional",
      runtime: "claude",
      model: command.model,
      source: "runtime-startup-readiness",
    };
  }
}
