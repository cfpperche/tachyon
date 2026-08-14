/**
 * spec 265 task 9 — the async TOOL PLAN, injected into the SYNC previewInstall (mirrors gitHookState).
 *
 * Resolves the host platform + (optionally) the redirect-resolved final URL for each declared tool, producing
 * the per-tool plan the consent drawer shows and the fingerprint binds. The async work (platform probes,
 * redirect resolution) happens HERE; previewInstall stays sync and consumes the result. applyInstall (task 10)
 * re-resolves redirects immediately before the download and aborts on drift (H4).
 */

import path from "node:path";
import type { LoadedPlugin } from "./engine.js";
import type { ToolLaunchPolicy } from "@tachyon/engine/plugins/manifest.js";
import { resolveHostPlatform, type PlatformResolution } from "./toolPlatform.js";

export interface ToolPlanItem {
  name: string;
  version: string;
  /** the resolved platform key whose pin was selected. */
  resolvedPlatform: string;
  /** the manifest-declared download URL. */
  declaredUrl: string;
  /** the redirect-resolved URL that will actually be fetched (== declaredUrl when no resolver is injected). */
  finalUrl: string;
  /** the downloaded artifact's sha256. */
  sha256: string;
  /** the EXECUTABLE bytes' sha256 (== sha256 for a raw binary; the archive's binSha256 otherwise). */
  binSha256: string;
  /** present when the artifact is an archive to unwrap. */
  archive?: { type: string; innerPath: string };
  /** the on-disk leaf filename (the tool name for a raw binary; the archive member's basename otherwise). */
  exeName: string;
  /** spec 269 — the launcher-enforced launch policy, carried for the lockfile + the consent fingerprint. */
  launchPolicy?: ToolLaunchPolicy;
}

export interface ToolPlan {
  items: ToolPlanItem[];
  /** tools that can't be provisioned for this host (unsupported platform / no matching pin) — surfaced, never silent. */
  unsupported: { name: string; reason: string }[];
}

export interface ToolPlanDeps {
  /** the resolved host platform (default: the memoized real resolution). Injectable for tests. */
  platform?: PlatformResolution;
  /** resolve a URL's redirect chain to its final URL (default: identity — apply re-resolves with the real GET). */
  resolveFinalUrl?: (url: string) => Promise<string>;
}

/** Build the per-tool provisioning plan for the running host. Never throws. */
export async function gatherToolPlan(plugin: LoadedPlugin, deps: ToolPlanDeps = {}): Promise<ToolPlan> {
  const tools = plugin.manifest.tools;
  const names = Object.keys(tools);
  if (names.length === 0) return { items: [], unsupported: [] };

  const platform = deps.platform ?? resolveHostPlatform();
  const resolveFinalUrl = deps.resolveFinalUrl ?? (async (u: string) => u);

  const items: ToolPlanItem[] = [];
  const unsupported: { name: string; reason: string }[] = [];

  for (const name of names) {
    const decl = tools[name];
    if (!platform.ok) {
      unsupported.push({ name, reason: `${platform.code}: ${platform.detail}` });
      continue;
    }
    // pick the first preference-ordered platform key the tool actually pins.
    const key = platform.keys.find((k) => decl.platforms[k]);
    if (!key) {
      unsupported.push({ name, reason: `no pinned artifact for ${platform.keys.join(" / ")}` });
      continue;
    }
    const p = decl.platforms[key]!;
    const finalUrl = await resolveFinalUrl(p.url);
    const binSha256 = p.archive ? p.archive.binSha256 : p.sha256;
    const exeName = p.archive ? path.posix.basename(p.archive.innerPath) : name;
    items.push({
      name,
      version: decl.version,
      resolvedPlatform: key,
      declaredUrl: p.url,
      finalUrl,
      sha256: p.sha256,
      binSha256,
      ...(p.archive ? { archive: { type: p.archive.type, innerPath: p.archive.innerPath } } : {}),
      exeName,
      ...(decl.launchPolicy ? { launchPolicy: decl.launchPolicy } : {}),
    });
  }

  return { items, unsupported };
}
