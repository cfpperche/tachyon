import { createHash } from "node:crypto";
import type { AgentProfileReferenceV1, AgentProfileV1 } from "./agentProfileSchema.js";
import type { AgentProfileStudioEditableV1 } from "./agentProfileStudio.js";
import {
  PERSISTENT_INSTRUCTIONS_FILE_NAME,
  PERSISTENT_INSTRUCTIONS_REFERENCE_ID,
  persistentInstructionsRefusal,
  persistentInstructionsText,
  studioOwnsPersistentInstructions,
} from "./agentInstructionsDocument.js";

/**
 * t-d48775 — the HOST half of authoring an agent's persistent instructions: the bytes, their digest,
 * and the pinned `references[]` entry that names them.
 *
 * Split from `agentInstructionsDocument.ts` because this module hashes, and hashing needs
 * `node:crypto` — which cannot be dragged into the Agent Studio webview bundle. Same split, same
 * reason, as `agentWorkspaceCommands.ts` / `agentWorkspaceCommandWrite.ts`.
 *
 * The two halves cannot drift silently: `agentProfileSchemaV1`'s `requireKind` refinement fails a
 * profile whose `prompt.instructions` names an id with no matching `instructions` reference.
 */

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A profile-local reference entry without the two fields the transaction fills from the minted id. */
export type LocalPersistentInstructionsReference = Omit<AgentProfileReferenceV1, "scope" | "owner">;

export interface PersistentInstructionsWrite {
  /** Published in the same transaction as the patch — allowlisted name, digest-checked on arrival. */
  artifacts: Array<{ path: string; text: string; sha256: string }>;
  /** For `create`: the transaction stamps `scope: "profile"` and `owner: <minted agentId>`. */
  localReferences: LocalPersistentInstructionsReference[];
}

/**
 * What this mutation should publish for `prompt.instructions`.
 *
 * Returns nothing for text the human left blank (that is how the binding is CLEARED — the id, the
 * reference and the document simply stop being written) and nothing for a FOREIGN binding, which
 * the Studio neither displays nor overwrites.
 *
 * Refuses text the resolver would later reject. The limits live once, in
 * `persistentInstructionsRefusal`, and are checked here rather than only in the form: the form is
 * one of the doors, and a document published past the limit would resolve to a refusal at spawn —
 * an agent saved successfully and unable to start.
 */
export function persistentInstructionsWriteFor(
  editable: Pick<AgentProfileStudioEditableV1, "instructions">,
  current?: AgentProfileV1["prompt"],
): PersistentInstructionsWrite {
  const artifacts: PersistentInstructionsWrite["artifacts"] = [];
  const localReferences: LocalPersistentInstructionsReference[] = [];
  if (!studioOwnsPersistentInstructions(current)) return { artifacts, localReferences };

  const authored = editable.instructions;
  const refusal = persistentInstructionsRefusal(authored);
  if (refusal) throw new Error(refusal);
  if (authored.trim().length > 0) {
    const text = persistentInstructionsText(authored);
    const sha256 = digest(text);
    artifacts.push({ path: PERSISTENT_INSTRUCTIONS_FILE_NAME, text, sha256 });
    localReferences.push({
      id: PERSISTENT_INSTRUCTIONS_REFERENCE_ID,
      kind: "instructions",
      path: PERSISTENT_INSTRUCTIONS_FILE_NAME,
      mode: "pinned",
      sha256,
    });
  }
  return { artifacts, localReferences };
}

/**
 * The `references[]` an EDIT should write, given the list the other Studio writers produced.
 *
 * Chains over a base list rather than rebuilding from the stored profile, for the same reason the
 * workspace-command and Evolution merges chain: each rebuild from `current.references` would drop
 * what the previous writer just added.
 *
 * Owns one id and nothing else. A foreign instructions binding passes through untouched, because
 * `persistentInstructionsWriteFor` published nothing for it and the filter below only removes the id
 * this Studio authors.
 */
export function mergedPersistentInstructionsReferences(
  current: AgentProfileV1,
  write: PersistentInstructionsWrite,
  base?: AgentProfileReferenceV1[],
): AgentProfileReferenceV1[] {
  const kept = (base ?? current.references ?? []).filter(
    (reference) => reference.id !== PERSISTENT_INSTRUCTIONS_REFERENCE_ID,
  );
  return [
    ...kept,
    ...write.localReferences.map((reference) => ({
      ...reference,
      scope: "profile" as const,
      owner: current.agentId,
    })),
  ];
}
