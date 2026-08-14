/**
 * spec 284 — the async DATA PLAN, the non-executable sibling of `toolPlan.ts` (spec 265).
 *
 * Resolves, for each declared data artifact, the artifact to fetch for this host: a single cross-platform blob
 * (resolvedPlatform = "any", no host probe needed) OR the host-platform-selected pin. Produces the per-artifact
 * plan the consent drawer shows and the fingerprint binds; `applyInstall` re-resolves redirects before download and
 * aborts on drift (mirrors the tool path). Never throws.
 */

import type { LoadedPlugin } from "./engine.js";
import { resolveHostPlatform, type PlatformResolution } from "./toolPlatform.js";

/** the synthetic platform label for a single cross-platform data blob (no per-platform pin). */
export const DATA_ANY_PLATFORM = "any";

export interface DataPlanItem {
  name: string;
  version: string;
  /** the resolved platform key whose pin was selected, or `"any"` for a single cross-platform blob. */
  resolvedPlatform: string;
  /** the manifest-declared download URL. */
  declaredUrl: string;
  /** the redirect-resolved URL that will actually be fetched (== declaredUrl when no resolver is injected). */
  finalUrl: string;
  /** the data file's sha256 (the content-address identity). */
  sha256: string;
  /** the on-disk leaf filename (the declared `fileName`, else the data name). */
  fileName: string;
}

export interface DataPlan {
  items: DataPlanItem[];
  /** data artifacts with per-platform pins but none matching this host — surfaced, never silent. */
  unsupported: { name: string; reason: string }[];
}

export interface DataPlanDeps {
  /** the resolved host platform (default: the memoized real resolution). Injectable for tests. */
  platform?: PlatformResolution;
  /** resolve a URL's redirect chain to its final URL (default: identity — apply re-resolves with the real GET). */
  resolveFinalUrl?: (url: string) => Promise<string>;
}

/** Build the per-data-artifact provisioning plan for the running host. Never throws. */
export async function gatherDataPlan(plugin: LoadedPlugin, deps: DataPlanDeps = {}): Promise<DataPlan> {
  const data = plugin.manifest.data;
  const names = Object.keys(data);
  if (names.length === 0) return { items: [], unsupported: [] };

  const resolveFinalUrl = deps.resolveFinalUrl ?? (async (u: string) => u);

  const items: DataPlanItem[] = [];
  const unsupported: { name: string; reason: string }[] = [];

  for (const name of names) {
    const decl = data[name];
    const fileName = decl.fileName ?? name;

    if (decl.single) {
      // a single cross-platform blob: no host probe — it installs the same everywhere.
      const finalUrl = await resolveFinalUrl(decl.single.url);
      items.push({ name, version: decl.version, resolvedPlatform: DATA_ANY_PLATFORM, declaredUrl: decl.single.url, finalUrl, sha256: decl.single.sha256, fileName });
      continue;
    }

    // per-platform pins: resolve the host platform + the first preference-ordered key the artifact pins.
    const platforms = decl.platforms ?? {};
    const platform = deps.platform ?? resolveHostPlatform();
    if (!platform.ok) {
      unsupported.push({ name, reason: `${platform.code}: ${platform.detail}` });
      continue;
    }
    const key = platform.keys.find((k) => platforms[k]);
    if (!key) {
      unsupported.push({ name, reason: `no pinned artifact for ${platform.keys.join(" / ")}` });
      continue;
    }
    const p = platforms[key]!;
    const finalUrl = await resolveFinalUrl(p.url);
    items.push({ name, version: decl.version, resolvedPlatform: key, declaredUrl: p.url, finalUrl, sha256: p.sha256, fileName });
  }

  return { items, unsupported };
}
