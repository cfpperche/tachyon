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

import { SUPPORTED_RUNTIMES, type Runtime } from "./manifest.js";
import { parseLockfile, type PluginLock, type ExternalToolReqLock } from "./lockfile.js";

/** A plugin's freshness relative to its source. `unknown` = not yet checked (no update-check injected). */
export type PluginStatusKind =
  | "up-to-date"
  | "update-available"
  | "source-changed"
  | "drift"
  | "conflict"
  | "error"
  | "unknown";

/**
 * Action buttons the card surfaces.
 * - `update` = labeled version bump available
 * - `reapply` = t-4e5f11 same version, different source bytes (distinct word so it does not contradict the badge)
 * - `reinstall` = force-gated re-materialize over local edits
 */
export type PluginAction = "update" | "reapply" | "reinstall" | "remove";

export interface RuntimePill {
  runtime: Runtime;
  /** true ⇒ this runtime's recorded materialization is INTACT on disk (its lockfile targets still exist).
   *  false ⇒ a genuine drift signal: the plugin was installed into this runtime but its materialized files were
   *  since deleted. spec 263: this is computed from the runtime's TARGETS, NOT `detectRuntimes` — a skills-only
   *  codex install lands in `.agents/skills/` and never creates `.codex/`, so dir-presence is the wrong signal. */
  present: boolean;
}

export interface PluginStatus {
  kind: PluginStatusKind;
  /** the newer version, when kind === "update-available". */
  latestVersion?: string;
  /** a human one-liner — the conflict reason or error message. */
  detail?: string;
}

export interface InstalledPluginVM {
  name: string;
  version: string;
  /** the source-spec the user wrote (e.g. `github:org/repo@v1`); absent for a local-dir install. */
  sourceSpec?: string;
  /** short (7-char) resolved commit, when the plugin came from git. */
  shortCommit?: string;
  /** true when installed from a local dir (no git provenance in the lockfile). */
  localInstall: boolean;
  /** per-runtime pills, in SUPPORTED_RUNTIMES order. */
  runtimes: RuntimePill[];
  status: PluginStatus;
  /** which buttons to render, derived deterministically from `status.kind`. */
  actions: PluginAction[];
  /** spec 270 — present ⇒ render a "Config" button that opens this workspace-relative config file (+ optional
   *  schema for editor validation). Independent of `status`/`actions`. */
  config?: { file: string; schemaFile?: string };
  /** spec 270 — present ⇒ render a "Docs" button opening this https URL externally. */
  docsUrl?: string;
  /** spec 287 — the plugin's declared external (system) tools with present/missing + whether an assisted install is
   *  offered, injected by the host (spawn-free presence + lockfile req). Empty/absent ⇒ the card renders no tools row. */
  externalTools?: ExternalToolVM[];
  /** t-fb216a — runtimes this workspace RUNS that this plugin DECLARES support for and was never installed into
   *  (`declared ∩ present − lock.runtimes`). Absent when there is no gap or when the host injected no `declared`
   *  set. Distinct from a `RuntimePill` with `present:false`: that is DRIFT (installed here, files deleted); this
   *  is a runtime the install never covered. Drives the card's coverage notice. */
  uncoveredRuntimes?: Runtime[];
  /** SDD 486 Phase C — MCP servers this plugin ships, with whether each is currently applied. Absent when the
   *  plugin ships none. Installed-not-applied is a first-class row, never omitted as if the server were absent. */
  mcpServers?: McpContributionVM[];
  skills?: ContributionVM[];
  hooks?: ContributionVM[];
  gitHooks?: ContributionVM[];
}

/** One MCP server a plugin ships, and whether the human has applied it to this workspace. */
export interface McpContributionVM {
  name: string;
  applied: boolean;
}
export interface ContributionVM { name: string; applied: boolean; }

/** spec 287 — one external (system) tool on an installed card: present/missing + whether Tachyon can offer the
 *  consent-gated assisted install (a PM command is declared for some PM) vs manual-only. */
export interface ExternalToolVM {
  name: string;
  present: boolean;
  /** true ⇒ the lockfile req declares at least one package-manager install command (the card may offer "Install in
   *  terminal"); false ⇒ manual-only. The host still re-validates + needs a matching host PM at click time. */
  installable: boolean;
  /** the human manual-install fallback string (always shown for a missing tool). */
  manual: string;
  /** spec 289 (D6 audit disclosure) — the candidate binary names when MORE THAN ONE is accepted (e.g. a browser:
   *  google-chrome / chromium); shown so the user sees which host binaries satisfy this one requirement. Absent for
   *  a single-name tool. */
  names?: string[];
  /** spec 289 (D6) — the winning trusted absolute path when present (which candidate actually resolved). */
  resolvedPath?: string;
}

export interface PluginsViewModel {
  /** workspace runtimes present, in SUPPORTED_RUNTIMES order — drives the "this workspace runs …" subtitle. */
  present: Runtime[];
  installed: InstalledPluginVM[];
  /** set when the lockfile is corrupt — the view shows a banner and suppresses the untrustworthy list. */
  parseError?: string;
  /** true when there is no lockfile or it records zero plugins (cold state). */
  empty: boolean;
  /** SDD 486 Phase C — applied-state unreadable. Distinct from a lockfile parseError: the install list
   *  is still trustworthy, but apply/unapply must not run (we cannot tell which MCP servers are live). */
  appliedError?: string;
}

/**
 * One plugin's update-check outcome, computed by the provider (I/O: re-resolve the source ref + previewUpdate)
 * and injected so the VM stays pure & synchronously testable. Absent for a plugin ⇒ status `unknown`.
 */
export type UpdateCheck =
  | { kind: "up-to-date" }
  | { kind: "update-available"; latestVersion: string }
  /** t-4e5f11 — manifest version matches lock, but integrity.payload differs. */
  | { kind: "source-changed"; version: string }
  | { kind: "drift"; detail?: string }
  | { kind: "conflict"; detail?: string }
  | { kind: "error"; detail: string };

export interface BuildPluginsInput {
  /** raw `.tachyon/plugins.lock.json` contents, or undefined when the file does not exist (cold state). */
  lockfileText?: string;
  /** a NON-ENOENT lockfile read failure (EACCES/EISDIR/…) the host could not resolve — surfaced as a
   *  parseError banner with the list suppressed, NOT masqueraded as "no plugins". Takes precedence. */
  readError?: string;
  /** runtimes present in the workspace (from `detectRuntimes`) — drives the "this workspace runs …" subtitle. */
  present: ReadonlySet<Runtime>;
  /** spec 263 — per-plugin (keyed by name) the runtimes whose recorded materialization is INTACT on disk (the
   *  host stats each runtime's lockfile targets). Drives the installed-card pills. Omit a plugin ⇒ its pills fall
   *  back to `present` (back-compat); a runtime absent from its list shows as drift. */
  intact?: Record<string, Runtime[]>;
  /** per-plugin (keyed by name) update-check results; omit a plugin ⇒ its status is `unknown`. */
  updateChecks?: Record<string, UpdateCheck>;
  /** spec 287 — per-plugin (keyed by name) external-tool statuses, computed by the host (spawn-free presence +
   *  lockfile req). Omit a plugin ⇒ the card shows no external-tools row. */
  externalStatuses?: Record<string, ExternalToolVM[]>;
  /** t-fb216a — per-plugin (keyed by name) the runtimes the INSTALLED payload's manifest declares, read by the host
   *  from `.tachyon/plugins/<name>/tachyon-plugin.json`. Omit a plugin ⇒ no coverage gap is computed for it: an
   *  unreadable manifest is absence of evidence, and inventing "not installed for grok" from it would be a lie. */
  declared?: Record<string, Runtime[]>;
  /** SDD 486 Phase C — per-plugin (keyed by name) the MCP servers the lockfile recorded, with applied-state.
   *  Omit a plugin ⇒ the card shows no MCP row. */
  mcpStatuses?: Record<string, McpContributionVM[]>;
  skillStatuses?: Record<string, ContributionVM[]>;
  hookStatuses?: Record<string, ContributionVM[]>;
  gitHookStatuses?: Record<string, ContributionVM[]>;
  /** applied-state read failure — surfaced as a banner; apply/unapply stay disabled. */
  appliedError?: string;
}

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

/** the host's spawn-free presence oracle result for one external-tool requirement (spec 287/289). */
export type ExternalPresenceResult = { present: boolean; path?: string };

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
