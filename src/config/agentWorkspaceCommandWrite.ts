import { createHash } from "node:crypto";
import type { AgentProfileReferenceV1, AgentProfileV1 } from "./agentProfileSchema.js";
import type { AgentProfileStudioEditableV1 } from "./agentProfileStudio.js";
import {
  WORKSPACE_SETUP_PATH,
  WORKSPACE_SETUP_REFERENCE_ID,
  WORKSPACE_VERIFY_PATH,
  WORKSPACE_VERIFY_REFERENCE_ID,
  studioOwnsWorkspaceCommands,
  workspaceCommandLinesText,
  workspaceCommandText,
} from "./agentWorkspaceCommands.js";

/**
 * t-afc86e — the HOST half of authoring an agent's workspace commands: the bytes, their digests, and
 * the pinned `references[]` entries that name them.
 *
 * Split from `agentWorkspaceCommands.ts` for one concrete reason: this module hashes, and hashing
 * needs `node:crypto`. `agentProfileStudio.ts` — which builds the rest of the mutation — is imported
 * by the Agent Studio webview bundle, and dragging `node:crypto` in there is the same class of
 * breakage that keeps `formLogic.ts`'s runtime exports out of `agent-studio-shell/domain.ts`. So the
 * ids and the ownership rule are pure and shared; the bytes are computed here, host-side only.
 *
 * The two halves cannot drift silently: `agentProfileSchemaV1`'s own `requireKind` refinement fails a
 * profile whose `workspace.verify` names an id with no matching `verification` reference, so a
 * caller that set the field and forgot the entry gets a refused transaction, not a dangling pointer.
 */

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A profile-local reference entry without the two fields the transaction fills from the minted id. */
export type LocalWorkspaceCommandReference = Omit<AgentProfileReferenceV1, "scope" | "owner">;

export interface WorkspaceCommandWrite {
  /** Published in the same transaction as the patch — allowlisted names, digest-checked on arrival. */
  artifacts: Array<{ path: string; text: string; sha256: string }>;
  /** For `create`: the transaction stamps `scope: "profile"` and `owner: <minted agentId>`. */
  localReferences: LocalWorkspaceCommandReference[];
}

/**
 * What this mutation should publish for `workspace.verify` / `worktree.setup`.
 *
 * Returns nothing for a field the human left blank (that is how the field is CLEARED — the id and
 * the reference simply stop being written) and nothing for a field whose current reference is
 * FOREIGN, which the Studio neither displays nor overwrites.
 *
 * Note the orphan this deliberately accepts: clearing a verify leaves `workspace-verify` on disk
 * with nothing pointing at it. Nothing reads an unreferenced file — `resolveReferences` iterates
 * `profile.references`, not the directory — so it is inert residue, and removing it would mean
 * teaching the lifecycle transaction to DELETE artifacts, a compensation path with real failure
 * modes, to reclaim a few dozen bytes.
 */
export function workspaceCommandWriteFor(
  editable: Pick<AgentProfileStudioEditableV1, "verify" | "worktree">,
  current?: Pick<NonNullable<AgentProfileV1["workspace"]>, "verify" | "worktree">,
): WorkspaceCommandWrite {
  const owned = studioOwnsWorkspaceCommands({ verify: current?.verify, setup: current?.worktree?.setup });
  const artifacts: WorkspaceCommandWrite["artifacts"] = [];
  const localReferences: LocalWorkspaceCommandReference[] = [];

  const verify = editable.verify.trim();
  if (owned.verify && verify.length > 0) {
    const text = workspaceCommandText(verify);
    const sha256 = digest(text);
    artifacts.push({ path: WORKSPACE_VERIFY_PATH, text, sha256 });
    localReferences.push({
      id: WORKSPACE_VERIFY_REFERENCE_ID,
      kind: "verification",
      path: WORKSPACE_VERIFY_PATH,
      mode: "pinned",
      sha256,
    });
  }

  const setup = editable.worktree.setup.map((command) => command.trim()).filter((command) => command.length > 0);
  if (owned.setup && setup.length > 0) {
    const text = workspaceCommandLinesText(setup);
    const sha256 = digest(text);
    artifacts.push({ path: WORKSPACE_SETUP_PATH, text, sha256 });
    localReferences.push({
      id: WORKSPACE_SETUP_REFERENCE_ID,
      kind: "worktree-setup",
      path: WORKSPACE_SETUP_PATH,
      mode: "pinned",
      sha256,
    });
  }

  return { artifacts, localReferences };
}

/**
 * The full `references[]` an EDIT should write: everything the profile already had, minus the two ids
 * this Studio owns, plus whatever it is publishing now.
 *
 * Rebuilt rather than appended to, because clearing a field has to REMOVE its entry — an append-only
 * merge would leave a pinned reference nothing points at, and the next load would refuse the profile
 * for a dangling `requireKind` rather than for anything the human did.
 *
 * Every other reference — Soul, instructions, the Evolution selector, every capability — passes
 * through untouched. This writer owns two ids and nothing else.
 */
export function mergedWorkspaceCommandReferences(
  current: AgentProfileV1,
  write: WorkspaceCommandWrite,
): AgentProfileReferenceV1[] {
  const owned = new Set([WORKSPACE_VERIFY_REFERENCE_ID, WORKSPACE_SETUP_REFERENCE_ID]);
  const kept = (current.references ?? []).filter((reference) => !owned.has(reference.id));
  return [
    ...kept,
    ...write.localReferences.map((reference) => ({
      ...reference,
      scope: "profile" as const,
      owner: current.agentId,
    })),
  ];
}
