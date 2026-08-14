import type { Runtime } from "@tachyon/engine/plugins/manifest.js";
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


/** the host's spawn-free presence oracle result for one external-tool requirement (spec 287/289). */
export type ExternalPresenceResult = { present: boolean; path?: string };
