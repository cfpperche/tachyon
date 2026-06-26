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
import { parseLockfile, type PluginLock } from "./lockfile.js";

/** A plugin's freshness relative to its source. `unknown` = not yet checked (no update-check injected). */
export type PluginStatusKind = "up-to-date" | "update-available" | "drift" | "conflict" | "error" | "unknown";

/** Action buttons the card surfaces. `reinstall` = force-gated re-materialize over local edits. */
export type PluginAction = "update" | "reinstall" | "remove";

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
}

export interface PluginsViewModel {
  /** workspace runtimes present, in SUPPORTED_RUNTIMES order — drives the "this workspace runs …" subtitle. */
  present: Runtime[];
  installed: InstalledPluginVM[];
  /** set when the lockfile is corrupt — the view shows a banner and suppresses the untrustworthy list. */
  parseError?: string;
  /** true when there is no lockfile or it records zero plugins (cold state). */
  empty: boolean;
}

/**
 * One plugin's update-check outcome, computed by the provider (I/O: re-resolve the source ref + previewUpdate)
 * and injected so the VM stays pure & synchronously testable. Absent for a plugin ⇒ status `unknown`.
 */
export type UpdateCheck =
  | { kind: "up-to-date" }
  | { kind: "update-available"; latestVersion: string }
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
}

/** Map an injected update-check to the card's status struct. */
function statusFrom(check: UpdateCheck | undefined): PluginStatus {
  if (!check) return { kind: "unknown" };
  switch (check.kind) {
    case "up-to-date":
      return { kind: "up-to-date" };
    case "update-available":
      return { kind: "update-available", latestVersion: check.latestVersion };
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

function toInstalledVM(lock: PluginLock, present: ReadonlySet<Runtime>, intact: Runtime[] | undefined, check: UpdateCheck | undefined): InstalledPluginVM {
  const status = statusFrom(check);
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
  };
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
    return { present, installed: [], empty: true };
  }

  const { lockfile, errors } = parseLockfile(input.lockfileText);
  if (!lockfile) {
    return { present, installed: [], parseError: errors.join("; "), empty: false };
  }

  const checks = input.updateChecks ?? {};
  const installed = Object.values(lockfile.plugins)
    .map((lock) => toInstalledVM(lock, input.present, input.intact?.[lock.name], checks[lock.name]))
    // locale-independent, stable order (plugin names are ASCII kebab by manifest contract; don't depend on locale).
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return { present, installed, empty: installed.length === 0 };
}
