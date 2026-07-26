/**
 * Spec 257 (D5) + t-7426de — Grok Build headless-capture adapter.
 *
 * Grok single-turn: `grok -p <prompt> --output-format json` emits one JSON object on stdout
 * with `text`, `stopReason`, `sessionId`, optional `total_cost_usd` / `modelUsage` (see Grok
 * user-guide headless mode). We never treat raw interactive TUI output as the answer.
 *
 * Mapping (honest v1): clean `text` + exit 0 → ok; blank text → empty_output; unparseable +
 * nonzero → process_error; unparseable + zero → parse_error; structured error / refusal-like
 * stopReason → model_error / refused. Wall-clock timeout/cancel stay on the runner (D6).
 *
 * Flags pinned against Grok Build CLI help (0.2.x): -p/--single, --output-format, --json-schema,
 * --permission-mode, --no-memory, --no-subagents, --model. Sandbox custom profiles are NOT used
 * (require user-defined sandbox.toml); least-privilege intent maps to permission-mode only.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProbeResult, TerminationReason } from "../taxonomy.js";
import type { CapabilityReport, HeadlessCaptureAdapter, Invocation, ProbeSpec, RawOutcome } from "./types.js";

const execFileP = promisify(execFile);
const ADAPTER_VERSION = "1";

interface GrokHeadlessJson {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  error?: string | { message?: string };
  is_error?: boolean;
  total_cost_usd?: number;
  thought?: string;
  num_turns?: number;
  /**
   * SDD 474 — provider-reported usage keyed by the model identity that actually ran. Measured on
   * `grok 0.2.112`: `{"modelUsage":{"grok-4.5-build":{"inputTokens":2240,"outputTokens":31,…}}}`.
   * Unlike Claude there is no `canonicalModel` sub-field, so the KEY is the only identity available.
   * Retained only as opaque evidence — never parsed into a family by trimming the string.
   */
  modelUsage?: Record<string, unknown>;
}

/**
 * SDD 474 — the model identifiers Grok reported running. Absence returns undefined so the probe
 * service records `unproven`; nothing here infers identity from cost, tokens or the requested model.
 */
function reportedNativeModels(result: GrokHeadlessJson): string[] | undefined {
  const usage = result.modelUsage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
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

/**
 * Extract Grok's headless JSON from possibly-noisy stdout: whole-stdout parse, else last
 * JSON object line that looks like a headless result (`text` and/or `sessionId` / `stopReason`).
 */
export function extractGrokResult(stdout: string): GrokHeadlessJson | null {
  const tryParse = (s: string): GrokHeadlessJson | null => {
    try {
      const o = JSON.parse(s) as unknown;
      if (!o || typeof o !== "object" || Array.isArray(o)) return null;
      const r = o as GrokHeadlessJson;
      // Prefer a clear headless envelope; reject bare tool-event noise without result fields.
      if (
        typeof r.text === "string" ||
        typeof r.sessionId === "string" ||
        typeof r.stopReason === "string" ||
        typeof r.error === "string" ||
        (r.error && typeof r.error === "object")
      ) {
        return r;
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

function permissionMode(spec: ProbeSpec): string[] {
  // OQ6 — neutral intent → Grok permission-mode (runtime-native, advisory).
  return [
    "--permission-mode",
    spec.sandbox === "workspace-write" ? "acceptEdits" : "plan",
  ];
}

function errorMessage(parsed: GrokHeadlessJson): string {
  if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
  if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
    return parsed.error.message.trim();
  }
  return "";
}

export interface GrokAdapterDeps {
  versionProbe?: () => Promise<string | null>;
}

export function createGrokAdapter(deps: GrokAdapterDeps = {}): HeadlessCaptureAdapter {
  const versionProbe =
    deps.versionProbe ??
    (async () => {
      try {
        const { stdout } = await execFileP("grok", ["--version"], { timeout: 10_000 });
        return stdout.trim() || "unknown";
      } catch {
        return null;
      }
    });

  return {
    runtime: "grok",
    adapterVersion: ADAPTER_VERSION,
    // Grok reports `modelUsage` in its result JSON, so a requested model is provable (SDD 474).
    reportsEffectiveModel: true,

    buildInvocation(spec: ProbeSpec): Invocation {
      // Headless single-turn: no tools, no memory, no subagents (bounded probe surface).
      const args = [
        "-p",
        spec.prompt,
        "--output-format",
        "json",
        "--no-memory",
        "--no-subagents",
        "--tools",
        "",
        ...permissionMode(spec),
      ];
      const schema = jsonSchemaForArchetype(spec.archetype);
      if (schema) args.push("--json-schema", schema);
      if (spec.model) args.push("--model", spec.model);
      return { cmd: "grok", args, cwd: spec.cwd };
    },

    interpret(raw: RawOutcome): ProbeResult {
      const parsed = extractGrokResult(raw.stdout);
      const native: ProbeResult["native"] = {
        runtime: "grok",
        stopReason: parsed?.stopReason,
        sessionId: parsed?.sessionId,
        ...(parsed ? { reportedNativeModels: reportedNativeModels(parsed) } : {}),
      };
      if (!parsed) {
        if (raw.exitCode !== 0) {
          return base("process_error", raw.stderr.trim() || "grok exited non-zero with no result JSON", raw, native);
        }
        return base("parse_error", "could not parse grok --output-format json result", raw, native);
      }
      const cost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : undefined;
      const errMsg = errorMessage(parsed);
      if (parsed.is_error || errMsg) {
        const stop = (parsed.stopReason ?? "").toLowerCase();
        const reason: TerminationReason =
          /refus|policy|content.?filter|safety/i.test(stop) || /refus/i.test(errMsg)
            ? "refused"
            : "model_error";
        return {
          ...base(reason, errMsg || parsed.text?.trim() || "grok returned an error result", raw, native),
          costUsd: cost,
        };
      }
      const text = (parsed.text ?? "").trim();
      if (!text) return { ...base("empty_output", "", raw, native), costUsd: cost };
      // Nonzero exit with a usable answer is still a model-level failure class.
      if (raw.exitCode !== 0 && raw.exitCode !== null) {
        return {
          ...base("model_error", text || raw.stderr.trim() || "grok exited non-zero", raw, native),
          costUsd: cost,
        };
      }
      return { ...base("ok", text, raw, native), costUsd: cost };
    },

    async detectCapability(): Promise<CapabilityReport> {
      const version = await versionProbe();
      return version
        ? { available: true, binaryVersion: version }
        : { available: false, reason: "grok CLI not found on PATH" };
    },
  };
}

function base(reason: TerminationReason, lastMessage: string, raw: RawOutcome, native: ProbeResult["native"]): ProbeResult {
  return { reason, lastMessage, exitCode: raw.exitCode, timedOut: false, native };
}

/** Default adapter wired to the real `grok --version` probe. */
export const grokAdapter = createGrokAdapter();
