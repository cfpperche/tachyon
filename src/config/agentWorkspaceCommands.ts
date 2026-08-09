/**
 * t-afc86e — the contract for an agent's worktree setup commands.
 *
 * ## Why they are references and not scalars
 *
 * A canonical profile stores these as reference ids (`workspace.worktree.setup`),
 * pointing at pinned entries in `references[]`. That was already the design and it already worked:
 * the schema accepts it and the resolver reads, digest-checks and carries it. Only two things were
 * missing — the resolver discarded the bytes it had just verified, and the projection refused
 * instead of materializing. This module is the contract those two ends now share.
 *
 * The indirection keeps the bytes digest-pinned inside `agent.yml`, which the host authority signs.
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
 * Agent Studio authors this fixed reference id. Any other setup reference is foreign: the form does
 * not show it, the writer does not touch it, and an edit preserves it verbatim.
 */
/** Profile-local file holding the setup commands, one per line. */
export const WORKSPACE_SETUP_PATH = "workspace-setup";

/** The reference ids Agent Studio owns. Anything else pointing at these fields is foreign. */
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

/**
 * Does this profile's `worktree.setup` belong to Agent Studio, or to someone
 * else?
 *
 * Foreign means: the field is set and names an id this Studio does not author. The Studio then shows
 * nothing and writes nothing for that field — it neither renders a value it cannot explain nor
 * overwrites one it did not create. The one shape that must never happen is a form that displays
 * blank for a field that has a value, because the next save writes the blank back.
 */
export function studioOwnsWorkspaceCommands(current: { setup?: readonly string[] }): { setup: boolean } {
  return { setup: (current.setup ?? []).every((id) => id === WORKSPACE_SETUP_REFERENCE_ID) };
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
  setup: readonly string[];
  current?: { setup?: readonly string[] };
}): { setup: string[] } {
  const owned = studioOwnsWorkspaceCommands(input.current ?? {});
  return {
    setup: owned.setup
      ? (input.setup.some((command) => command.trim().length > 0) ? [WORKSPACE_SETUP_REFERENCE_ID] : [])
      : [...(input.current?.setup ?? [])],
  };
}
