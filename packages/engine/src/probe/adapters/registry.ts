import type { HeadlessCaptureAdapter } from "./types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { grokAdapter } from "./grok.js";

/** The adapters registered by the product's headless-probe door. */
export function headlessProbeAdapters(): Map<string, HeadlessCaptureAdapter> {
  return new Map([
    ["claude", claudeAdapter],
    ["codex", codexAdapter],
    ["grok", grokAdapter],
  ]);
}
