/**
 * The one list the resolver and the projection share: which profile-local reference kinds have their
 * BYTES turned into fields on the runtime entry.
 *
 * It has to be one list, in one place, because the two ends fail in opposite directions. The
 * resolver reads it to decide whether to carry `resolvedText` for a reference it just digest-checked;
 * the projection reads it to decide whether a reference is materialized or is an unknown it must
 * REFUSE the agent over. A kind in one and not the other is either a refusal for a reference the
 * product understands, or a materialization with no bytes behind it.
 *
 * It lived in `agentWorkspaceCommands.ts` while `worktree-setup` was the only member (t-afc86e);
 * t-d48775 added `instructions` and that home stopped describing it.
 *
 * ## What is deliberately NOT here
 *
 * `memory` — a lane whose whole point is per-item human approval. Materializing it would put content
 * on a runtime entry that nobody approved, which is the opposite of what the lane is for.
 *
 * ## Why `instructions` IS here
 *
 * It was held out on the same reasoning as `memory`: a formation lane, delivered under its own
 * authority at spawn. Measured on 2026-08-09, that delivery reached no agent that can exist — the
 * lane resolves only against a `FormationAuthorityVector`, and SDD 490's DELIVERY half is unticked
 * and gated on measured native-lane suppression for three runtimes. Meanwhile `prompt.instructions`
 * had a writer (portable-bundle import) and a schema, and the projection refused it, so importing a
 * bundle with instructions produced an agent that dropped off the roster. Materializing here is what
 * gives the binding a reader.
 *
 * The bytes are the SAME bytes the lane resolves (`persistentInstructions.ts` reads this exact
 * pinned `instructions.md`), so when 490's delivery half lands it inherits one document rather than
 * competing with a second format.
 */
export const MATERIALIZED_PROFILE_REFERENCE_KINDS: ReadonlySet<string> = new Set([
  "worktree-setup",
  "instructions",
]);
