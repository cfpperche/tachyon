import path from "node:path";
import { spawn } from "node:child_process";
import {
  PREFLIGHT_TIMEOUT_MS,
  boundedCloseMatches,
  type ParsedLaunchCommand,
  type RuntimeLaunchPreflight,
  type RuntimeLaunchPreflightPort,
} from "../launchPreflight.js";
import { CodexCatalogStreamParser } from "./codexCatalogStream.js";

export interface CodexProbeResult {
  code: number | null;
  slugs: readonly string[];
  failure?: "malformed" | "oversized" | "timeout";
}

export interface CodexProbeOptions {
  timeoutMs?: number;
}

export type CodexCatalogProbe = (binary: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => Promise<CodexProbeResult>;

export function probeCodexCatalog(
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: CodexProbeOptions = {},
): Promise<CodexProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args, "debug", "models"], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
    const parser = new CodexCatalogStreamParser();
    let settled = false;
    let forced: CodexProbeResult["failure"];
    const finish = (result: CodexProbeResult): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const terminate = (): void => {
      child.stdout.pause();
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ }
      }
      child.kill("SIGKILL");
    };
    const force = (failure: NonNullable<CodexProbeResult["failure"]>): void => {
      if (forced) return;
      forced = failure;
      terminate();
    };
    const timer = setTimeout(() => force("timeout"), options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (forced) return;
      const state = parser.write(chunk);
      if (state !== "continue") force(state);
    });
    child.on("error", () => finish({ code: null, slugs: [], ...(forced ? { failure: forced } : {}) }));
    child.on("close", (code) => {
      if (forced) return finish({ code: null, slugs: [], failure: forced });
      const result = parser.finish();
      finish(result.state === "ok"
        ? { code, slugs: result.slugs }
        : { code: null, slugs: [], failure: result.state });
    });
  });
}

export class CodexLaunchPreflight implements RuntimeLaunchPreflightPort {
  constructor(private readonly probe: CodexCatalogProbe = probeCodexCatalog) {}

  async check(command: ParsedLaunchCommand, env: Readonly<Record<string, string | undefined>>): Promise<RuntimeLaunchPreflight> {
    if (path.basename(command.binary) !== "codex") return { state: "unverifiable", reason: "runtime adapter mismatch" };
    if (!command.model) return { state: "supported", runtime: "codex", source: "default-model" };
    const result = await this.probe(command.probeBinary, command.probeArgv, env);
    if (result.failure === "timeout") return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog probe timed out" };
    if (result.failure === "oversized") return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog exceeded output limit" };
    if (result.failure === "malformed") return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog was malformed" };
    if (result.code !== 0) return { state: "failed", code: "runtime_preflight_failed", runtime: "codex", reason: "model catalog probe failed" };
    if (result.slugs.includes(command.model)) return { state: "supported", runtime: "codex", model: command.model, source: "codex-debug-models" };
    return { state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: command.model, suggestions: boundedCloseMatches(command.model, result.slugs) };
  }
}
