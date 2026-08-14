/**
 * SDD 490 Fatia A — the WRITE host for formation authority, and the only one there is.
 *
 * `lifecycleHost.ts` builds the store the spawn path reads, and it is read-only on purpose:
 * `authorizeMutation: () => false`, `resolvePayload` throws. That must stay true — a read path that
 * could publish would be a wider capability than the spawn path ever asked for. So the write path
 * gets its own host rather than a loosened version of that one.
 *
 * Both hosts open the SAME SQLite authority under the workspace root. That is the point: adoption is
 * only worth anything if the spawn path sees it. What differs is the capability each host grants.
 *
 * This host grants exactly one thing:
 *
 *     mutation === "bootstrap" && caller.kind === "human" && workspaceId === this workspace
 *
 * Every other mutation, every launch, every selector read and revocation is refused here. An editing
 * caller belongs in `HumanLaneTransactionService` against a host that grants `profile-edit`; this one
 * cannot be borrowed for it, which is what keeps "one door to bootstrap" from decaying into "one
 * object that happens to also bootstrap".
 *
 * On the `kind: "human"` check — read the header of `bootstrapTransaction.ts` before trusting it.
 * `FormationCaller.kind` is a value this host's own caller constructs; it is not a proof of humanity
 * and nothing in this repository can produce one. What makes it meaningful is that the surfaces an
 * agent can reach have no route here at all. The check is the second lock, not the first.
 */

import path from "node:path";
import { FormationAuthorityStore } from "./authorityStore.js";
import { FormationBootstrapService } from "./bootstrapTransaction.js";

export interface FormationAdoptionHostInput {
  /**
   * The machine-local key `loadOrCreateHmacKey` custodies. Absent ⇒ no host.
   *
   * Adoption does not itself need the key — it publishes no snapshot and attests no suppression. It
   * is gated on the key anyway so the two halves of formation appear and disappear together: without
   * it the spawn path has no port at all, and letting a human adopt into a workspace whose delivery
   * path is dead would manufacture exactly the "adopted, still refuses" state this spec exists to
   * remove.
   */
  hostKey: Buffer | undefined;
  /** The workspace's existing private host root — the same one `createFormationLifecycleHost` uses. */
  hostRoot: string;
  workspaceId: string;
  now?: () => string;
}

export interface FormationAdoptionHost {
  readonly service: FormationBootstrapService;
  readonly store: FormationAuthorityStore;
}

export function createFormationAdoptionHost(input: FormationAdoptionHostInput): FormationAdoptionHost | undefined {
  if (!input.hostKey || input.hostKey.length < 32) return undefined;
  const store = new FormationAuthorityStore(path.join(input.hostRoot, "formation"), {
    ...(input.now ? { now: input.now } : {}),
    // Adoption never launches, never resolves a payload, never touches a selector. Each of these is a
    // deliberate throw or refusal rather than an unreachable convenience: if one of them ever starts
    // being reached, that is a capability this host grew without anyone deciding it should.
    authorizeLaunch: () => false,
    authorizeSelectorRevocation: () => false,
    authorizeSelectorRead: () => false,
    resolvePayload: () => {
      throw new Error("formation adoption host does not publish payloads: snapshot preparation is not available here");
    },
    authorizeMutation: ({ operation, caller, workspaceId }) =>
      operation === "bootstrap" && caller.kind === "human" && workspaceId === input.workspaceId,
  });
  return { store, service: new FormationBootstrapService(store) };
}
