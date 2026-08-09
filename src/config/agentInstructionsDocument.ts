/**
 * t-d48775 — the contract for an agent's persistent instructions: the durable text a human writes
 * once and every session of that agent starts with.
 *
 * ## The shape is not new, and deliberately so
 *
 * A canonical profile has always stored this as `prompt.instructions` naming a pinned profile-local
 * `references[]` entry whose bytes live at `instructions.md` inside the profile directory. That is
 * the shape `agentProfileBundle.ts`'s importer already writes and `persistentInstructions.ts`
 * already reads, digest-checked, and it is the shape the formation lane resolves when a vector
 * exists. Nothing here invents a second format: a new key in `agent.yml` would make the exported
 * bundle stop matching the living profile, which is two truths about one agent.
 *
 * What was missing is the middle: no door in the product WROTE that binding (only bundle import
 * did), and the projection REFUSED to read it, so the field in Agent Studio was disabled for every
 * agent that can exist. This module is the contract the writer and the reader now share.
 *
 * ## Fixed id marks OWNERSHIP
 *
 * Same rule as `agentWorkspaceCommands.ts`: Agent Studio authors exactly one reference id. A binding
 * pointing anywhere else belongs to whoever published it — the form shows it read-only and says so,
 * and the writer neither rewrites nor clears it. The shape that must never happen is a form that
 * renders blank for an agent that HAS instructions, because the next save writes that blank over
 * them.
 *
 * ## Node-free by construction
 *
 * `agentProfileStudio.ts` imports this, and that module is compiled into the Agent Studio webview
 * bundle. Hashing (which needs `node:crypto`) is the host's half, in `agentInstructionsWrite.ts` —
 * the same split, for the same reason, as `agentWorkspaceCommands.ts` / `agentWorkspaceCommandWrite.ts`.
 */

/** Profile-local document holding the persistent instructions text. */
export const PERSISTENT_INSTRUCTIONS_FILE_NAME = "instructions.md";

/** The one reference id Agent Studio authors. Anything else bound to `prompt.instructions` is foreign. */
export const PERSISTENT_INSTRUCTIONS_REFERENCE_ID = "persistent-instructions";

/** The `references[].kind` the binding must carry; the schema already restricts it to this value. */
export const PERSISTENT_INSTRUCTIONS_REFERENCE_KIND = "instructions";

export const PERSISTENT_INSTRUCTIONS_MAX_BYTES = 64 * 1024;
export const PERSISTENT_INSTRUCTIONS_MAX_CHARS = 20_000;

/**
 * Is this profile's `prompt.instructions` binding Agent Studio's to edit?
 *
 * Absent counts as owned: there is nothing to overwrite, so the form may author one.
 */
export function studioOwnsPersistentInstructions(current?: { instructions?: string }): boolean {
  const id = current?.instructions;
  return id === undefined || id === PERSISTENT_INSTRUCTIONS_REFERENCE_ID;
}

/**
 * The reference id a saved profile should carry, given what the human authored and what is there.
 *
 * `undefined` means the binding is REMOVED — which is how the field is cleared. A foreign binding is
 * returned verbatim: the form does not display it, so it must not be able to clear it either.
 */
export function studioPersistentInstructionsId(input: {
  instructions: string;
  current?: { instructions?: string };
}): string | undefined {
  if (!studioOwnsPersistentInstructions(input.current)) return input.current?.instructions;
  return input.instructions.trim().length > 0 ? PERSISTENT_INSTRUCTIONS_REFERENCE_ID : undefined;
}

/**
 * Why these bytes cannot be persistent instructions, or `undefined` when they can.
 *
 * The same limits `persistentInstructions.ts` enforces when it resolves the document, expressed on
 * TEXT so the form can refuse before saving and the host can refuse at the door. Both must agree:
 * a form that accepts what the transaction rejects is a save button that fails, and a form stricter
 * than the transaction silently narrows what the product supports.
 *
 * Empty is NOT a refusal here — blank is how the binding is cleared, and `studioPersistentInstructionsId`
 * turns it into an absent id rather than an empty document.
 */
export function persistentInstructionsRefusal(text: string): string | undefined {
  if (text.trim().length === 0) return undefined;
  if (text.includes("\0")) return "Persistent instructions cannot contain NUL bytes.";
  const chars = Array.from(text).length;
  if (chars > PERSISTENT_INSTRUCTIONS_MAX_CHARS) {
    return `Persistent instructions are ${chars} characters; the limit is ${PERSISTENT_INSTRUCTIONS_MAX_CHARS}.`;
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > PERSISTENT_INSTRUCTIONS_MAX_BYTES) {
    return `Persistent instructions are ${bytes} bytes; the limit is ${PERSISTENT_INSTRUCTIONS_MAX_BYTES}.`;
  }
  return undefined;
}

/**
 * The exact bytes a save publishes for the text a human typed.
 *
 * Trailing newline normalized so that re-saving an unchanged form produces an unchanged digest, and
 * so the file reads as a document rather than a fragment. `persistentInstructionsText` is the only
 * place this decision lives; the reader takes the file verbatim.
 */
export function persistentInstructionsText(text: string): string {
  return `${text.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n`;
}

/**
 * The document's bytes as the FORM shows them — the inverse of `persistentInstructionsText`.
 *
 * The pair has to round-trip exactly, or opening a profile and pressing Save with no edit would
 * republish different bytes: a new digest, a new revision, and a dirty form the human never dirtied.
 */
export function persistentInstructionsFormValue(fileText: string): string {
  return fileText.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}
