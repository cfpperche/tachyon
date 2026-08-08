/**
 * t-afc86e — the contract for an agent's own workspace COMMANDS: the verify gate that proves its
 * branch shippable, and the setup commands its worktree needs before anything can run.
 *
 * Both were consumed and unauthorable. `effectiveVerify` resolves per-agent over global,
 * `runWorktreeSetup` runs the setup list, the Bridge's `verify_agent` door and `wait_for_agent`'s
 * "ready AND green" both read the gate — and no authoring path could write either: the Studio
 * rendered them permanently disabled, the editable schema had no field, and the projection refused
 * the whole profile with "verification/setup references are not materialized yet".
 *
 * ## Why they are references and not scalars
 *
 * A canonical profile stores these as REFERENCE IDS (`workspace.verify`, `workspace.worktree.setup`),
 * pointing at pinned entries in `references[]`. That was already the design and it already worked:
 * the schema accepts it and the resolver reads, digest-checks and carries it. Only two things were
 * missing — the resolver discarded the bytes it had just verified, and the projection refused
 * instead of materializing. This module is the contract those two ends now share.
 *
 * The indirection earns its keep: the bytes are digest-pinned inside `agent.yml`, which the host
 * authority signs, so a verify command cannot be swapped underneath a running agent without
 * invalidating the profile. A scalar in the profile would have the same property, but the reference
 * shape is also what lets a workspace publish one project-scoped verifier that several agents point
 * at — the monorepo case this capability exists for.
 *
 * ## One file per field, fixed names
 *
 * Decided 2026-08-08. `worktree.setup` is an array of ids, so N setup commands COULD have been N
 * artifacts — but the lifecycle's artifact allowlist is a fixed set of names, so that shape would
 * have had to invent a ceiling (`setup-0..setup-7`): a limit nobody chose, that nobody would
 * remember, and that becomes an unexplainable refusal the day someone writes the ninth command. One
 * file holding one command per line has no ceiling to invent, and it stays readable on disk.
 *
 * ## Fixed ids mark OWNERSHIP
 *
 * Agent Studio authors exactly these two reference ids. A `workspace.verify` naming anything else —
 * a project-scoped verifier the workspace supplies, say — is FOREIGN: the form does not show it, the
 * writer does not touch it, and an edit preserves it verbatim. Without that rule the first save from
 * a form that could not display the value would silently delete it.
 */

/** Profile-local file holding the verify command (the whole file is the command). */
export const WORKSPACE_VERIFY_PATH = "workspace-verify";
/** Profile-local file holding the setup commands, one per line. */
export const WORKSPACE_SETUP_PATH = "workspace-setup";

/** The reference ids Agent Studio owns. Anything else pointing at these fields is foreign. */
export const WORKSPACE_VERIFY_REFERENCE_ID = "workspace-verify";
export const WORKSPACE_SETUP_REFERENCE_ID = "workspace-setup";

/**
 * Reference kinds whose BYTES the projection turns into fields on the runtime entry, and which the
 * resolver therefore carries the text of.
 *
 * Deliberately not every non-capability kind: Soul, instructions and memory are formation lanes
 * delivered under their own authority, and carrying their bytes here would put prompt content into a
 * value that is passed around, digested and logged for entirely different reasons.
 */
export const MATERIALIZED_WORKSPACE_REFERENCE_KINDS: ReadonlySet<string> = new Set([
  "verification",
  "worktree-setup",
]);

/** "npm test\n\ncargo test\n" -> ["npm test", "cargo test"] — blank lines are formatting, not commands. */
export function parseWorkspaceCommandLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** The file bytes for a list of commands — the exact inverse of `parseWorkspaceCommandLines`. */
export function workspaceCommandLinesText(commands: readonly string[]): string {
  return `${commands.map((command) => command.trim()).filter((command) => command.length > 0).join("\n")}\n`;
}

/** The file bytes for a single command (the verify gate). */
export function workspaceCommandText(command: string): string {
  return `${command.trim()}\n`;
}

/**
 * Does this profile's `workspace.verify` / `worktree.setup` belong to Agent Studio, or to someone
 * else?
 *
 * Foreign means: the field is set and names an id this Studio does not author. The Studio then shows
 * nothing and writes nothing for that field — it neither renders a value it cannot explain nor
 * overwrites one it did not create. The one shape that must never happen is a form that displays
 * blank for a field that has a value, because the next save writes the blank back.
 */
export function studioOwnsWorkspaceCommands(current: {
  verify?: string;
  setup?: readonly string[];
}): { verify: boolean; setup: boolean } {
  return {
    verify: current.verify === undefined || current.verify === WORKSPACE_VERIFY_REFERENCE_ID,
    setup: (current.setup ?? []).every((id) => id === WORKSPACE_SETUP_REFERENCE_ID),
  };
}

/**
 * The reference IDS a saved profile should carry for these two fields, given what the human authored
 * and what is already there.
 *
 * Pure and digest-free so it can run in the browser bundle beside the rest of the Studio mutation
 * builders; the bytes, digests and reference entries are the host's half
 * (`agentWorkspaceCommandWrite.ts`), because those need a hash and this module must not pull
 * `node:crypto` into a webview.
 */
export function studioWorkspaceCommandIds(input: {
  verify: string;
  setup: readonly string[];
  current?: { verify?: string; setup?: readonly string[] };
}): { verify?: string; setup: string[] } {
  const owned = studioOwnsWorkspaceCommands(input.current ?? {});
  return {
    ...(owned.verify
      ? (input.verify.trim() ? { verify: WORKSPACE_VERIFY_REFERENCE_ID } : {})
      : { verify: input.current!.verify }),
    setup: owned.setup
      ? (input.setup.some((command) => command.trim().length > 0) ? [WORKSPACE_SETUP_REFERENCE_ID] : [])
      : [...(input.current?.setup ?? [])],
  };
}
