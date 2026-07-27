import path from "node:path";
import { spawn } from "node:child_process";
import {
  PREFLIGHT_TIMEOUT_MS,
  boundedCloseMatches,
  type ParsedLaunchCommand,
  type RuntimeLaunchPreflight,
  type RuntimeLaunchPreflightPort,
} from "../launchPreflight.js";

/**
 * t-85c586 — Grok's authoritative model catalog.
 *
 * Unlike Claude, Grok ships a bounded catalog command, and the CLI itself treats it as the source of
 * truth. Measured on grok 0.2.112 (2026-07-26), `grok models` prints:
 *
 *     You are logged in with grok.com.
 *
 *     Default model: grok-4.5
 *
 *     Available models:
 *       * grok-4.5 (default)
 *
 * and a `--model` outside that list is refused by Grok before any turn runs:
 *
 *     Couldn't set model 'grok-4.5-build': Invalid params: "unknown model id".
 *     Run 'grok models' to see available models.
 *
 * That measured round trip — the catalog lists it, or the CLI refuses it, and the CLI's own error
 * names this command — is what makes `supported` honest here rather than `provisional`.
 *
 * A caution worth keeping, because it looks like a bug otherwise: the catalog namespace is NOT the
 * usage-reporting namespace. `grok-4.5-build` is what `modelUsage` reports as the effective model
 * (SDD 474), yet it is not a selectable id — pinning it fails. Do not "reconcile" the two.
 *
 * Nothing here invents a catalog. Anything that is not a clean, parseable listing — a failed probe,
 * a logged-out CLI, an unrecognized layout — resolves to `unverifiable`/`failed`, never to a guess
 * in either direction.
 */

/** `grok models` output is a short listing; well past any real catalog, and far below a memory risk. */
export const GROK_CATALOG_MAX_BYTES = 256 * 1024;
/** Bound the parsed set so a pathological listing cannot balloon suggestions. */
export const GROK_CATALOG_MAX_SLUGS = 512;
const MAX_SLUG_LENGTH = 128;

export interface GrokModelCatalog {
  slugs: string[];
  defaultModel?: string;
}

/**
 * Parse `grok models` output. Returns null when the text is not a recognizable catalog, which is the
 * honest answer for a logged-out CLI, an error message, or a layout this was not measured against.
 *
 * Deliberately anchored on the `Available models:` header rather than "any bulleted line": the same
 * output carries a `Default model:` line and a login banner, and a looser rule would happily read a
 * future unrelated bullet list as a catalog.
 */
export function parseGrokModelCatalog(text: string): GrokModelCatalog | null {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*available models\s*:\s*$/i.test(line));
  if (header < 0) return null;

  const slugs: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (!line.trim()) continue; // a blank line inside the block is layout, not the end of it
    // Entries are `  * <slug>` or `  - <slug>`, optionally annotated: `  * grok-4.5 (default)`.
    const entry = /^\s+(?:[*\-•])\s+(\S+)/.exec(line);
    if (!entry) break; // first non-entry, non-blank line ends the block
    const slug = entry[1]!;
    if (slug.length > MAX_SLUG_LENGTH) return null; // not a shape we measured; refuse rather than trim
    if (!slugs.includes(slug)) slugs.push(slug);
    if (slugs.length > GROK_CATALOG_MAX_SLUGS) return null;
  }
  if (slugs.length === 0) return null; // a header with nothing under it proves nothing

  const declaredDefault = /^\s*default model\s*:\s*(\S+)\s*$/im.exec(text)?.[1];
  return { slugs, ...(declaredDefault ? { defaultModel: declaredDefault } : {}) };
}

export interface GrokProbeResult {
  code: number | null;
  text: string;
  failure?: "timeout" | "oversized";
}

export interface GrokProbeOptions {
  timeoutMs?: number;
  cwd?: string;
}

export type GrokCatalogProbe = (
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options?: GrokProbeOptions,
) => Promise<GrokProbeResult>;

/** Run `grok models` under the same env/cwd the launch would use, bounded in time and output. */
export function probeGrokCatalog(
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  options: GrokProbeOptions = {},
): Promise<GrokProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args, "models"], {
      cwd: options.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
    });
    let text = "";
    let settled = false;
    let forced: GrokProbeResult["failure"];
    const finish = (result: GrokProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const terminate = (): void => {
      child.stdout.pause();
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* fall through to the direct kill */
        }
      }
      child.kill("SIGKILL");
    };
    const force = (failure: NonNullable<GrokProbeResult["failure"]>): void => {
      if (forced) return;
      forced = failure;
      terminate();
    };
    const timer = setTimeout(() => force("timeout"), options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (forced) return;
      text += chunk.toString("utf8");
      if (text.length > GROK_CATALOG_MAX_BYTES) force("oversized");
    });
    child.on("error", () => finish({ code: null, text: "", ...(forced ? { failure: forced } : {}) }));
    child.on("close", (code) => {
      if (forced) return finish({ code: null, text: "", failure: forced });
      finish({ code, text });
    });
  });
}

export class GrokLaunchPreflight implements RuntimeLaunchPreflightPort {
  constructor(private readonly probe: GrokCatalogProbe = probeGrokCatalog) {}

  async check(
    command: ParsedLaunchCommand,
    env: Readonly<Record<string, string | undefined>>,
    cwd?: string,
  ): Promise<RuntimeLaunchPreflight> {
    if (path.basename(command.binary) !== "grok") {
      return { state: "unverifiable", code: "runtime_preflight_unverifiable", reason: "runtime adapter mismatch" };
    }
    // No pin means nothing to verify: Grok picks its own default and reports it in the same command.
    if (!command.model) return { state: "supported", runtime: "grok", source: "default-model" };

    const result = await this.probe(command.probeBinary, command.probeArgv, env, { cwd });
    if (result.failure === "timeout") {
      return { state: "failed", code: "runtime_preflight_failed", runtime: "grok", reason: "model catalog probe timed out" };
    }
    if (result.failure === "oversized") {
      return { state: "failed", code: "runtime_preflight_failed", runtime: "grok", reason: "model catalog exceeded output limit" };
    }
    if (result.code !== 0) {
      return { state: "failed", code: "runtime_preflight_failed", runtime: "grok", reason: "model catalog probe failed" };
    }
    const catalog = parseGrokModelCatalog(result.text);
    if (!catalog) {
      // A logged-out CLI prints a sign-in notice instead of a listing. Refusing to interpret that is
      // the point: an unreadable catalog is not evidence that a model is missing OR present.
      return {
        state: "unverifiable",
        code: "runtime_preflight_unverifiable",
        runtime: "grok",
        reason: "grok models reported no readable catalog (is the CLI signed in?)",
      };
    }
    if (catalog.slugs.includes(command.model)) {
      return { state: "supported", runtime: "grok", model: command.model, source: "grok-models" };
    }
    return {
      state: "unsupported",
      code: "runtime_model_unavailable",
      runtime: "grok",
      model: command.model,
      suggestions: boundedCloseMatches(command.model, catalog.slugs),
    };
  }
}
