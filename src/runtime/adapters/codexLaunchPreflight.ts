import path from "node:path";
import { spawn } from "node:child_process";
import {
  PREFLIGHT_MAX_OUTPUT_BYTES,
  PREFLIGHT_TIMEOUT_MS,
  boundedCloseMatches,
  type ParsedLaunchCommand,
  type RuntimeLaunchPreflight,
  type RuntimeLaunchPreflightPort,
} from "../launchPreflight.js";

export interface CodexProbeResult { code: number | null; stdout: Buffer; timedOut?: boolean; oversized?: boolean }
export type CodexCatalogProbe = (binary: string, env: Readonly<Record<string, string | undefined>>) => Promise<CodexProbeResult>;

export function probeCodexCatalog(binary: string, env: Readonly<Record<string, string | undefined>>): Promise<CodexProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["debug", "models"], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: CodexProbeResult): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ code: null, stdout: Buffer.alloc(0), timedOut: true }); }, PREFLIGHT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PREFLIGHT_MAX_OUTPUT_BYTES) { child.kill("SIGKILL"); finish({ code: null, stdout: Buffer.alloc(0), oversized: true }); }
      else chunks.push(chunk);
    });
    child.on("error", () => finish({ code: null, stdout: Buffer.alloc(0) }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(chunks) }));
  });
}

export class CodexLaunchPreflight implements RuntimeLaunchPreflightPort {
  constructor(private readonly probe: CodexCatalogProbe = probeCodexCatalog) {}

  async check(command: ParsedLaunchCommand, env: Readonly<Record<string, string | undefined>>): Promise<RuntimeLaunchPreflight> {
    if (path.basename(command.binary) !== "codex") return { state: "unverifiable", reason: "runtime adapter mismatch" };
    if (!command.model) return { state: "supported", runtime: "codex", source: "default-model" };
    const result = await this.probe(command.binary, env);
    if (result.timedOut) return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog probe timed out" };
    if (result.oversized) return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog exceeded output limit" };
    if (result.code !== 0) return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog probe failed" };
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.toString("utf8")); } catch { return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog was malformed" }; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { models?: unknown }).models)) {
      return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog was malformed" };
    }
    const slugs = (parsed as { models: unknown[] }).models.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as { slug?: unknown; visibility?: unknown };
      return typeof item.slug === "string" && item.slug.length <= 128 && item.visibility === "list" ? [item.slug] : [];
    }).slice(0, 512);
    if (slugs.includes(command.model)) return { state: "supported", runtime: "codex", model: command.model, source: "codex-debug-models" };
    return { state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: command.model, suggestions: boundedCloseMatches(command.model, slugs) };
  }
}
