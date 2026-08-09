/** Honest, syntactic classification of Tachyon's opening-prompt delivery seam. */
export type OpeningPromptCapability =
  | { status: "prompt"; runtime: string; channel: "startup-argument" | "tui-prefill" }
  | { status: "native-external"; runtime: "hermes"; detail: string }
  | { status: "unsupported"; runtime: string; detail: string };

import { resolveRuntimeBinary, runtimePromptAdapter } from "./runtimePromptAdapters.js";

export function resolveBinary(cmd: string): string {
  return resolveRuntimeBinary(cmd);
}

export function openingPromptCapability(cmd: string): OpeningPromptCapability {
  const runtime = resolveBinary(cmd);
  const adapter = runtimePromptAdapter(cmd);
  if (adapter?.compose) {
    return { status: "prompt", runtime, channel: adapter.channel as "startup-argument" | "tui-prefill" };
  }
  if (runtime === "hermes") {
    return {
      status: "native-external",
      runtime: "hermes",
      detail: "Hermes opening prompts are delivered through its native TUI query environment",
    };
  }
  return {
    status: "unsupported",
    runtime: runtime || "unknown",
    detail: "Use a direct supported command (or env/npx/bunx/pnpx launcher); shell wrappers and renamed binaries are not inferred",
  };
}

export const describeOpeningPromptCapability = openingPromptCapability;
