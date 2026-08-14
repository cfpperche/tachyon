import type { PluginStatusKind, PluginAction, RuntimePill, PluginStatus, InstalledPluginVM, McpContributionVM, ContributionVM, ExternalToolVM, PluginsViewModel, UpdateCheck, BuildPluginsInput, ExternalPresenceResult } from "@tachyon/webview-ui/plugins/viewModel";
export type { PluginStatusKind, PluginAction, RuntimePill, PluginStatus, InstalledPluginVM, McpContributionVM, ContributionVM, ExternalToolVM, PluginsViewModel, UpdateCheck, BuildPluginsInput, ExternalPresenceResult } from "@tachyon/webview-ui/plugins/viewModel";
/**
 * spec 250 — pure view-model for the Plugins View (the extension UI). Shapes the committed lockfile +
 * the workspace's present runtimes + (optionally injected) per-plugin update-check results into a
 * render-ready model the webview can paint with zero further logic.
 *
 * PURE by design: no fs, no network, no vscode. All I/O (reading the lockfile, detectRuntimes, and the
 * update checks that re-resolve a source + previewUpdate) lives in the provider; the results are passed in.
 * This keeps every display/derivation decision unit-testable in `test/unit/` — the vscode-bound provider
 * stays a thin shell (logic in the vscode layer escapes CI).
 */

import { SUPPORTED_RUNTIMES, type Runtime } from "@tachyon/engine/plugins/manifest.js";
import { parseLockfile, type PluginLock, type ExternalToolReqLock } from "@tachyon/engine/plugins/lockfile.js";

/** Map an injected update-check to the card's status struct. */
function statusFrom(check: UpdateCheck | undefined): PluginStatus {
  if (!check) return { kind: "unknown" };
  switch (check.kind) {
    case "up-to-date":
      return { kind: "up-to-date" };
    case "update-available":
      return { kind: "update-available", latestVersion: check.latestVersion };
    case "source-changed":
      return { kind: "source-changed", detail: `still v${check.version}` };
    case "drift":
      return { kind: "drift", detail: check.detail };
    case "conflict":
      return { kind: "conflict", detail: check.detail };
    case "error":
      return { kind: "error", detail: check.detail };
  }
}

function assertNever(x: never): never {
  throw new Error(`unhandled plugin status kind: ${String(x)}`);
}

/** Which buttons a card shows, purely from its status. `remove` is always offered. Exhaustive: a new
 *  PluginStatusKind becomes a compile error here, forcing an explicit product decision (not a silent default). */
function actionsFor(kind: PluginStatusKind): PluginAction[] {
  switch (kind) {
    case "update-available":
      return ["update", "remove"];
    case "source-changed":
      // distinct action word — "Update" next to "source changed · still vX" would contradict on the same line.
      return ["reapply", "remove"];
    case "drift":
    case "conflict":
      return ["reinstall", "remove"];
    case "up-to-date":
    case "error":
    case "unknown":
      return ["remove"];
    default:
      return assertNever(kind);
  }
}

/** Pills for the runtimes a plugin was installed into, in SUPPORTED_RUNTIMES order. `intact` (when provided) is
 *  the runtimes whose materialization the host verified still on disk; without it, fall back to dir-presence. */
function runtimePills(lock: PluginLock, present: ReadonlySet<Runtime>, intact: Runtime[] | undefined): RuntimePill[] {
  const installed = new Set(lock.runtimes);
  const intactSet = intact ? new Set(intact) : undefined;
  return SUPPORTED_RUNTIMES.filter((rt) => installed.has(rt)).map((rt) => ({ runtime: rt, present: intactSet ? intactSet.has(rt) : present.has(rt) }));
}

/**
 * t-fb216a — the RUNTIME-COVERAGE GAP: `declared ∩ present − lock.runtimes`. Three conjuncts, each load-bearing:
 * the plugin must SUPPORT the runtime (declared), the workspace must RUN it (present), and the install must never
 * have covered it (absent from the lockfile). Drop any one and the notice becomes noise or a lie.
 *
 * Why this is a signal and not a fix — measured on 0.56.158, 2026-08-02:
 *  - `previewUpdate` sets `target = new Set(plan.lock.runtimes)` (engine.ts:2135, spec 263) — the set consented at
 *    install, deliberately NOT `detectRuntimes`. So Update is STRUCTURALLY incapable of widening coverage. That
 *    rule is correct and this change does not touch it: widening without consent installs hooks into a runtime
 *    nobody approved. The defect was never the rule — it was that nothing said the gap existed.
 *  - `previewUpdate` then decides freshness by `fromVersion === toVersion` (engine.ts:2137). For the 8 plugins
 *    measured here the lock already sits at the repo's HIGHEST semver tag with matching versions, so the answer is
 *    a truthful "up to date" while grok is declared, running, and uncovered.
 *
 * REFUSED, deliberately:
 *  - Widening the update target to `detectRuntimes` — that is the spec 263 violation the whole design forbids.
 *  - Rewording "up to date" into "pinned — may be stale". The task premise was that a tag pin freezes the button
 *    forever; MEASURED FALSE: `resolveEffectiveUpdateSpec` (engine.ts:400-411) bumps a semver-shaped tag pin to the
 *    repo's highest semver tag, so v2.2.1 does resolve v2.3.1. Calling a following pin "frozen" would swap one
 *    half-truth for another, which is exactly what the constraint forbade. "Up to date" is left alone because it is
 *    true about the version; the gap is carried as its OWN fact instead of smuggled into the status word.
 *  - A sixth runtime registry. This reads the manifest the host already materialized and intersects it with the
 *    two sets the panel already had (`present`, `lock.runtimes`). No new source of runtime truth.
 */
function uncoveredRuntimes(lock: PluginLock, present: ReadonlySet<Runtime>, declared: Runtime[] | undefined): Runtime[] {
  if (!declared) return []; // no payload manifest read ⇒ no evidence ⇒ no claim
  const installed = new Set(lock.runtimes);
  const declaredSet = new Set(declared);
  return SUPPORTED_RUNTIMES.filter((rt) => declaredSet.has(rt) && present.has(rt) && !installed.has(rt));
}

function toInstalledVM(lock: PluginLock, present: ReadonlySet<Runtime>, intact: Runtime[] | undefined, check: UpdateCheck | undefined, externalTools: ExternalToolVM[] | undefined, declared: Runtime[] | undefined, mcpServers: McpContributionVM[] | undefined, skills?: ContributionVM[], hooks?: ContributionVM[], gitHooks?: ContributionVM[]): InstalledPluginVM {
  const status = statusFrom(check);
  const uncovered = uncoveredRuntimes(lock, present, declared);
  return {
    name: lock.name,
    version: lock.version,
    ...(lock.source ? { sourceSpec: lock.source.spec, shortCommit: lock.source.resolvedCommit.slice(0, 7) } : {}),
    localInstall: !lock.source,
    runtimes: runtimePills(lock, present, intact),
    status,
    actions: actionsFor(status.kind),
    ...(lock.config ? { config: lock.config } : {}),
    ...(lock.docsUrl ? { docsUrl: lock.docsUrl } : {}),
    ...(externalTools && externalTools.length > 0 ? { externalTools } : {}),
    ...(uncovered.length > 0 ? { uncoveredRuntimes: uncovered } : {}),
    ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
    ...(skills && skills.length > 0 ? { skills } : {}),
    ...(hooks && hooks.length > 0 ? { hooks } : {}),
    ...(gitHooks && gitHooks.length > 0 ? { gitHooks } : {}),
  };
}

/** spec 287 + 289 — pure mapping of installed plugins → per-plugin external-tool statuses, given a presence oracle the
 *  HOST supplies (spawn-free, cached). The oracle gets the FULL req (so it honours the candidate `names` set — D7,
 *  no spawn/spawn-free divergence) and returns present + the winning path. Extracted from the vscode layer so the
 *  card-status derivation is unit-tested (logic in the vscode layer escapes CI). A plugin with no declared external
 *  tools is omitted entirely. */
export function buildExternalStatuses(plugins: Iterable<PluginLock>, resolve: (req: ExternalToolReqLock) => ExternalPresenceResult): Record<string, ExternalToolVM[]> {
  const out: Record<string, ExternalToolVM[]> = {};
  for (const p of plugins) {
    const reqs = p.externalTools ?? [];
    if (reqs.length === 0) continue;
    out[p.name] = reqs.map((req) => {
      const r = resolve(req);
      return {
        name: req.name,
        present: r.present,
        installable: Object.keys(req.install ?? {}).length > 0,
        manual: req.manual,
        ...(req.names && req.names.length > 1 ? { names: req.names } : {}), // D6 — disclose the candidate set (only when >1)
        // resolvedPath only for a NO-detect tool: the card's spawn-free check is detect-blind, so for a detect-tool it
        // cannot know the runtime-winning candidate — don't overclaim a path it didn't verify (codex LOW).
        ...(r.present && r.path && !req.detect ? { resolvedPath: r.path } : {}),
      };
    });
  }
  return out;
}

/** SDD 486 Phase C — lockfile mcp-server refs + applied-state → per-plugin rows. A plugin with no
 *  mcp-server targets is omitted (no empty row). Names are unique per plugin (one row, many runtimes). */
export function buildMcpStatuses(plugins: Iterable<PluginLock>, isApplied: (plugin: string, name: string) => boolean): Record<string, McpContributionVM[]> {
  const out: Record<string, McpContributionVM[]> = {};
  for (const p of plugins) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const t of p.targets) {
      if (t.kind !== "mcp-server" || typeof t.ref !== "string" || seen.has(t.ref)) continue;
      seen.add(t.ref);
      names.push(t.ref);
    }
    if (names.length === 0) continue;
    names.sort();
    out[p.name] = names.map((name) => ({ name, applied: isApplied(p.name, name) }));
  }
  return out;
}

export function buildContributionStatuses(plugins: Iterable<PluginLock>, targetKind: "skill-dir" | "settings-hook", isApplied: (plugin: string, name: string) => boolean): Record<string, ContributionVM[]> {
  const out: Record<string, ContributionVM[]> = {};
  for (const p of plugins) {
    const names = [...new Set(p.targets.filter((t) => t.kind === targetKind).map((t) => targetKind === "skill-dir" ? t.file.split("/").pop() : t.ref).filter((x): x is string => !!x))].sort();
    if (names.length > 0) out[p.name] = names.map((name) => ({ name, applied: isApplied(p.name, name) }));
  }
  return out;
}

/**
 * Build the Plugins View model. Pure: lockfile text + present runtimes + injected update-checks → render model.
 * A corrupt lockfile yields a `parseError` (banner, no list) rather than throwing.
 */
export function buildPluginsViewModel(input: BuildPluginsInput): PluginsViewModel {
  const present = SUPPORTED_RUNTIMES.filter((rt) => input.present.has(rt));

  // a real readability failure must not look like "no plugins" — surface it like a corrupt lockfile.
  if (input.readError !== undefined) {
    return { present, installed: [], parseError: input.readError, empty: false };
  }

  if (input.lockfileText === undefined) {
    return { present, installed: [], empty: true, ...(input.appliedError ? { appliedError: input.appliedError } : {}) };
  }

  const { lockfile, errors } = parseLockfile(input.lockfileText);
  if (!lockfile) {
    return { present, installed: [], parseError: errors.join("; "), empty: false };
  }

  const checks = input.updateChecks ?? {};
  const externals = input.externalStatuses ?? {};
  const mcp = input.mcpStatuses ?? {};
  const skills = input.skillStatuses ?? {};
  const hooks = input.hookStatuses ?? {};
  const gitHooks = input.gitHookStatuses ?? {};
  const installed = Object.values(lockfile.plugins)
    .map((lock) => toInstalledVM(lock, input.present, input.intact?.[lock.name], checks[lock.name], externals[lock.name], input.declared?.[lock.name], mcp[lock.name], skills[lock.name], hooks[lock.name], gitHooks[lock.name]))
    // locale-independent, stable order (plugin names are ASCII kebab by manifest contract; don't depend on locale).
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { present, installed, empty: installed.length === 0, ...(input.appliedError ? { appliedError: input.appliedError } : {}) };
}
