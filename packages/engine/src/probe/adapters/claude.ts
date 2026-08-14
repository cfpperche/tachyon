/**
 * Spec 257 (D5) — the claude headless-capture adapter. claude's print mode (`-p --output-format json`)
 * emits a single result JSON to stdout: `{ type:"result", subtype, is_error, result, total_cost_usd,
 * errors? }`. We map its native `subtype`/`is_error` onto the neutral taxonomy (D4) — a budget result
 * (`error_max_budget_usd`) is a `budget` reason, NOT a crash; the Claude `subtype` is quarantined under
 * `native` and never surfaces at the neutral layer.
 *
 * The runtime's exact flags are localized HERE (spec § Prior art: pin at impl time, capability-probe
 * rather than freeze). stdout can carry leading login/update noise, so the result JSON is extracted
 * robustly (whole-stdout parse, else the last JSON-shaped line).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProbeResult, TerminationReason } from "../taxonomy.js";
import type { CapabilityReport, Invocation, ProbeSpec, RawOutcome, StatelessCaptureAdapter } from "./types.js";

const execFileP = promisify(execFile);
const ADAPTER_VERSION = "1";

interface ClaudeResultJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  /** Provider-reported usage keyed by actual model identity. Retained only as opaque evidence. */
  modelUsage?: Record<string, { canonicalModel?: unknown }>;
}

function reportedModels(result: ClaudeResultJson): string[] | undefined {
  const usage = result.modelUsage;
  if (!usage || typeof usage !== "object") return undefined;
  const models = Object.values(usage)
    .map((entry) => typeof entry?.canonicalModel === "string" ? entry.canonicalModel : undefined)
    .filter((model): model is string => Boolean(model));
  return models.length > 0 ? [...new Set(models)].sort() : undefined;
}

/**
 * SDD 473 — the `modelUsage` KEYS are the provider-native identifiers
 * (`claude-haiku-4-5-20251001`), which are more precise than the `canonicalModel` family
 * (`claude-haiku-4-5`) captured above. The family alone cannot distinguish releases, so the keys are
 * preserved as the primary evidence of what actually ran.
 */
function reportedNativeModels(result: ClaudeResultJson): string[] | undefined {
  const usage = result.modelUsage;
  if (!usage || typeof usage !== "object") return undefined;
  const models = Object.keys(usage).filter((key) => key.trim().length > 0);
  return models.length > 0 ? [...new Set(models)].sort() : undefined;
}

function jsonSchemaForArchetype(archetype: string | undefined): string | undefined {
  if (archetype === "adversarial-review") {
    return JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "severity", "problem"],
            properties: {
              title: { type: "string" },
              severity: { type: "string", enum: ["blocker", "major", "minor"] },
              target: { type: "string" },
              problem: { type: "string" },
              fix: { type: "string" },
            },
          },
        },
        mostImportant: { type: "string" },
      },
    });
  }
  if (archetype === "factual-verify") {
    return JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["claims"],
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["claim", "verdict"],
            properties: {
              claim: { type: "string" },
              verdict: { type: "string", enum: ["true", "false", "unverifiable"] },
              confidence: { type: "string" },
              evidence: { type: "string" },
            },
          },
        },
      },
    });
  }
  return undefined;
}

/** Extract claude's result JSON from possibly-noisy stdout: whole parse, else the last JSON object line. */
export function extractClaudeResult(stdout: string): ClaudeResultJson | null {
  const tryParse = (s: string): ClaudeResultJson | null => {
    try {
      const o = JSON.parse(s) as unknown;
      // Require the canonical result envelope (`type:"result"`) — NOT merely the presence of a
      // `result`/`is_error` key, so a stray tool/MCP-startup JSON line can't be mistaken for the
      // answer and produce a false `ok` (codex review #9).
      if (o && typeof o === "object" && (o as ClaudeResultJson).type === "result") {
        return o as ClaudeResultJson;
      }
    } catch {
      /* not JSON */
    }
    return null;
  };
  const whole = tryParse(stdout.trim());
  if (whole) return whole;
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line && line.startsWith("{")) {
      const parsed = tryParse(line);
      if (parsed) return parsed;
    }
  }
  return null;
}

function sandboxFlag(spec: ProbeSpec): string[] {
  // OQ6 — neutral intent mapped to claude's permission-mode (runtime-native, advisory).
  return spec.sandbox === "workspace-write" ? ["--permission-mode", "acceptEdits"] : ["--permission-mode", "plan"];
}

export interface ClaudeAdapterDeps {
  /** returns the claude binary version, or null if unavailable (D5 capability probe). */
  versionProbe?: () => Promise<string | null>;
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): StatelessCaptureAdapter {
  const versionProbe =
    deps.versionProbe ??
    (async () => {
      try {
        const { stdout } = await execFileP("claude", ["--version"], { timeout: 10_000 });
        return stdout.trim() || "unknown";
      } catch {
        return null;
      }
    });

  return {
    runtime: "claude",
    adapterVersion: ADAPTER_VERSION,
    // Claude reports `modelUsage`, so a requested model is provable here (SDD 473).
    reportsEffectiveModel: true,
    // SDD 476 — that reporting is the provider's own usage accounting, the strongest kind available.
    modelEvidence: "provider-usage",

    buildInvocation(spec: ProbeSpec): Invocation {
      const args = ["-p", spec.prompt, "--output-format", "json", "--safe-mode", "--no-session-persistence", "--tools", "", ...sandboxFlag(spec)];
      const schema = jsonSchemaForArchetype(spec.archetype);
      if (schema) args.push("--json-schema", schema);
      if (spec.model) args.push("--model", spec.model);
      if (typeof spec.budgetUsd === "number") args.push("--max-budget-usd", String(spec.budgetUsd));
      return { cmd: "claude", args, cwd: spec.cwd };
    },

    interpret(raw: RawOutcome): ProbeResult {
      const parsed = extractClaudeResult(raw.stdout);
      const native = {
        runtime: "claude",
        subtype: parsed?.subtype,
        ...(parsed ? { reportedModels: reportedModels(parsed) } : {}),
        ...(parsed ? { reportedNativeModels: reportedNativeModels(parsed) } : {}),
      };
      if (!parsed) {
        if (raw.exitCode !== 0) {
          return base("process_error", raw.stderr.trim() || "claude exited non-zero with no result JSON", raw, native);
        }
        return base("parse_error", "could not parse claude --output-format json result", raw, native);
      }
      const cost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined;
      if (parsed.is_error) {
        const msg =
          (parsed.result?.trim() || (Array.isArray(parsed.errors) ? parsed.errors.join("; ") : "") || "claude returned an error result").trim();
        const reason: TerminationReason =
          parsed.subtype === "error_max_budget_usd" ? "budget" : /refus/i.test(parsed.subtype ?? "") ? "refused" : "model_error";
        return { ...base(reason, msg, raw, native), costUsd: cost };
      }
      const text = (parsed.result ?? "").trim();
      if (!text) return { ...base("empty_output", "", raw, native), costUsd: cost };
      return { ...base("ok", text, raw, native), costUsd: cost };
    },

    async detectCapability(): Promise<CapabilityReport> {
      const version = await versionProbe();
      return version ? { available: true, binaryVersion: version } : { available: false, reason: "claude CLI not found on PATH" };
    },
  };
}

function base(reason: TerminationReason, lastMessage: string, raw: RawOutcome, native: ProbeResult["native"]): ProbeResult {
  return { reason, lastMessage, exitCode: raw.exitCode, timedOut: false, native };
}

/** Default adapter wired to the real `claude --version` probe. */
export const claudeAdapter = createClaudeAdapter();
