# 371 — governed-release-boundary — plan

_Drafted 2026-07-10 after OQ-0 ratification (Option 1: Tier A now, Tier E additive). Grounded in the code read for the spec: `src/host-action/{broker,policy,externalPolicy,capability,audit,types}.ts`, `src/bridge/{approvalRequest,verifyTask,tools}.ts`, `src/worktree/evidence.ts` + `evidenceArtifacts.ts` (spec 274), `src/config/loadConfig.ts`. No implementation before this plan + its tasks are agreed; Fable does not implement — each phase is a delegated, gated ad-hoc._

## Approach

Compose four existing subsystems; build almost nothing new. The invariant is enforced at the STRONGEST tier the deployment supports and states which tier is active (per the ratified reframe): **Tier A (audit-only) ships now**; the credential-custody "enforced" claim (Tier E) is a later gate.

The through-line is one governed object — an **artifact-provenance record** — that flows: produced (Phase 1) → referenced by an approval (Phase 3) → checked by the broker before an outward action runs (Phase 2+3) → compared off-machine by the consumer (Phase 4). Each phase is independently useful, so we ship in order and stop wherever the maintainer wants.

## Key decisions (the spec's OQ-A/B/C, resolved with rejected alternatives)

### OQ-A — outward execution runs in a broker-owned child process, NOT `HostActionPort`

`HostActionPort` (src/host-action/port.ts + the agent-vscode adapter) is shaped for VS Code **host-API** actions (`reloadWindow`) — its executor calls into the extension host. Outward actions are **CLI-shaped** (`npm publish`, `docker push`, `code-server --install-extension`). Forcing a shell command through the VS Code adapter abuses the abstraction and has nowhere to attach credential materialization or the future Tier-E isolation.

**Decision:** add an `OutwardExecutionPort` implemented by a broker-owned child-process runner. It reuses the existing `HostActionBroker` decision path (caller resolution, closed-schema arg validation, hash-chained audit — `broker.ts`) but swaps the executor. The child process is where (a) the staged immutable artifact is the only operand, (b) the credential is materialized into the process env, and (c) Tier-E principal isolation will later attach (run the child under a distinct principal). Keeps `HostActionPort` untouched for host actions.

_Rejected:_ routing through `HostActionPort` — wrong shape, and it would put credential material in the extension-host process, the worst place for the eventual isolation boundary.

### OQ-B — credential aliases are catalog-pinned; the project names WHICH alias, never a raw env var

A project's `settings.releaseBoundary.outward[]` entry may reference a credential by an **alias** the build-pinned template catalog defines (e.g. `npm-token`, `vsce-pat`, `docker-login`). The alias resolves host-side to a value in the host keychain / `.tachyon/secrets.env` (same discipline as `FAL_KEY`: 0600, never argv/env into an agent pane). The project **cannot** name an arbitrary env var name to populate.

**Decision:** `outward[].credential: <alias>` where `<alias> ∈` the catalog's declared credential classes for that template; an unknown alias is a config error. The value never appears in `tachyon.yml`.

_Rejected:_ `credential: { env: <name>, from: host }` with a project-chosen env name — lets a malicious/edited tachyon.yml name `AWS_SECRET_ACCESS_KEY` (or anything) and have the broker helpfully materialize it into a process the project also controls the command of. The alias indirection keeps the *set* of exposable secrets build-pinned.

### OQ-C — file-upload templates ship first (clean sha256 binding); state templates are a later sub-phase

Binding "approve THE artifact" is clean when the outward action ships a **file**: stage the bytes, hash them, execute only against the staged object. It is weaker for **state** actions (`kubectl apply`, `terraform apply`) that transmit a rendered manifest / mutate remote state rather than upload one file.

**Decision:** Phases 1–3 ship **file-upload templates** — `npm-publish` (the packed tarball), `vsix-install`/`generic-upload`, `docker-push` bound to the **image digest** (OCI digests are platform-native immutable, so docker-push gets clean binding too). **State templates** (`kubectl-apply`, `terraform-apply`) are a labeled later sub-phase: they bind a host-computed manifest digest that the consumer can't always independently verify, so in Tier A they are **advisory + provenance-recorded**, not a hard broker gate, until their consumer-side check exists. The spec's non-overclaim rule applies: we don't pretend state actions are gated when their off-machine check isn't there.

_Rejected:_ shipping all templates uniformly in Phase 2 — would either block the whole feature on the hard state-binding problem or dishonestly claim state actions are bound.

## Phases (each a delegated, gated ad-hoc; forcing function per phase)

> **Naming (dueto-hardened):** P1–P3 build a **"governed broker path"**, NOT a "release boundary". A real
> boundary exists only in a deployment with the Phase-4 off-machine consumer gate. The no-overclaim
> contract + its test move into **Phase 1** and are REQUIRED in every partial ship (a stop after P2/P3
> must not read as governance). **P2 and P3 ship together** — P2 alone is dormant scaffolding (an outward
> capability that can never fire without P3's approval binding); shipping it as a "boundary" is a false
> signal. Emitted audit/UI must inventory known raw bypass paths.

### Phase 1 — `artifact-provenance` evidence kind + `record_artifact_provenance` (cheap, unblocks all)

- **Files:** new `src/artifactProvenance/` (record shape + host-compute helpers: sha256 of the file, `git rev-parse HEAD`/`HEAD^{tree}`, `git status --porcelain` for `workingTreeClean` + bounded dirty summary, read `.tachyon/verifications/<refSha>.json` for the gating verdict); `src/worktree/evidenceArtifacts.ts` (reuse the spec-274 managed content-addressed store to STAGE the bytes durably); `src/bridge/tools.ts` (new `record_artifact_provenance` tool — caller supplies ONLY a traversal-checked path + optional summary; host stamps everything trust-bearing incl. `producedBy` = Bridge-resolved caller).
- **Forcing function:** a test proving sha256/commit/treeSha/clean are host-computed and a caller-supplied hash/commit is impossible by construction (no such params); provenance links the verification record when present, records `verification: none` when absent.

### Phase 2 — `outward` capability class + template catalog

- **Files:** `src/config/loadConfig.ts` (parse + validate `settings.releaseBoundary.outward[]`, canonicalize + hash the snapshot → `declarationHash`; reject unknown template/credential-alias); new build-pinned `src/host-action/outwardCatalog.ts` (the fixed template set: executable, wrapper, credential class, per-template binding semantics — file-upload vs digest); `src/host-action/externalPolicy.ts` + `policy.ts` (compose two policy sources — build-pinned core actions + project-declared outward actions — and record which source authorized in the audit decision chain); new `OutwardExecutionPort` (OQ-A) wired into a broker instance.
- **Forcing function:** an `outward.<name>` action with no bound approval → `policy_denied`; a project entry naming a template/credential not in the catalog → config error; declaration edit changes `declarationHash`.

### Phase 3 — approval binding + broker preconditions (the teeth of Tier A)

- **Files:** `src/bridge/approvalRequest.ts` (extend the approval payload to embed the provenance snapshot verbatim — artifact name, sha256 short, commit, verification verdict, clean/DIRTY, destination/identity, `declarationHash`; `payloadHash` already makes it tamper-evident); broker precondition module for the outward class enforcing, host-side: (1) caller is agent-token-resolved — **reject legacy/self-declared callers** on both approval creation AND dispatch (the existing `StaticHostActionPolicy` already rejects non-agent callers — mirror it on the approval requester-match); (2) an integrity-valid `verdict:accept` verification record whose `refSha === provenance.commit` exists (broker reads it itself; break-glass is a separate audited capability); (3) the approved provenance sha256 equals the artifact's CURRENT host-recomputed sha256 (staged object, no swap race); (4) destination/identity match; (5) **single-use atomic claim** — approved→claimed transition before process launch, concurrent claims rejected, terminal outcome recorded separately; (6) `dirtyArtifacts: refuse` default (the spec reversed warn→refuse). Resolve stays host-side only (anti-laundering rule untouched — no new Bridge surface on resolution).
- **Forcing functions (each a test):** no-approval / resolved-DENIED / sha256-mismatch / consumed-twice denials; verification absent/failed/stale/wrong-refSha → denied; legacy-caller spoof rejected through every entry point; dirty-tree refused unless the explicit manifest-exception flow; `declarationHash` changed between approval and dispatch → `policy_version_mismatch`.

### Phase 4 — off-machine forcing function (the REAL Tier-A boundary)

- **Files:** `docs/` reference consumer gates (registry admission webhook / protected-CI release identity / cluster admission / immutable-digest allowlist) that REJECT an artifact whose digest isn't in recorded provenance; at least one WIRED forcing function in the dogfood/e2e suite that fails if an unrecorded digest is accepted.
- **Forcing function:** the e2e fails when a consumer gate accepts an artifact digest absent from recorded provenance; a test asserts no doc/UI string claims raw shipping is prevented in Tier A.

### Phase 5 — Tier E isolation conformance (DEFERRED per OQ-0)

- Design-only here: define the conformance check (agent principal cannot read the broker's fs/`/proc`/sockets/keychain) that ENABLES the credential-custody "enforced" claim. Building the OS-isolation substrate is a separate project (out of scope). Until it passes, the credential-custody criterion is SKIPPED (not silently passed) and Tier A stands.

## Files touched (summary)

`src/config/loadConfig.ts` · `src/host-action/{externalPolicy,policy,broker}.ts` + new `outwardCatalog.ts` + new `OutwardExecutionPort` · `src/bridge/{tools,approvalRequest}.ts` · new `src/artifactProvenance/` · `src/worktree/evidenceArtifacts.ts` (reuse) · reads `.tachyon/verifications/<refSha>.json` (no change to verifyTask) · docs + e2e for Phase 4.

## Risks

- **Overclaim regression** — the whole point is honesty; a doc/UI string that says "prevents" on a shared-UID box breaks the invariant. Mitigation: the Phase-4 string test is a hard gate, not advisory.
- **Provenance store growth** — staging every shippable artifact (VSIX/tarball can be MBs) into the managed store. Mitigation: size cap + streaming + retention policy (reuse spec-274 caps; a large artifact may store the digest + size only, staging opt-in per template).
- **Single-use claim races** — non-idempotent outward actions (a publish) double-firing. Mitigation: atomic approved→claimed before launch; retry = new approval unless the template proves a destination operation-id.
- **State-template dishonesty** — the tempting shortcut is to gate kubectl/terraform on a host-only manifest hash the consumer can't verify. Mitigation: OQ-C keeps them advisory in Tier A until a real consumer check exists.
- **`declarationHash` false denials** — unrelated config edits denying a valid dispatch. Mitigation: canonicalize the `releaseBoundary` sub-tree only, independent reload at approval AND dispatch, normalization test.

## Dueto hardening — folded (2026-07-10, .tachyon/reviews/371-plan-codex.md: 1 BLOCKER + 8 MAJOR + 1 MINOR)

- **BLOCKER — staged-object execution must be descriptor-bound, not pathname-bound.** Content-addressed naming does NOT make bytes immutable: a path can be swapped/mutated between the broker's sha256 check and the child opening it. Fix: the broker opens the staged object ONCE, validates size + full digest, and the child consumes that file descriptor (or a broker-created private snapshot) — never re-opens by path. Store writes are atomic create-if-absent, symlinks/non-regular files rejected, no overwrite. Test: swap the path between validation and child open → dispatch fails.
- **MAJOR — the single-use claim is a durable CAS, specified.** Host-owned compare-and-swap keyed by (approvalId, full payloadHash); explicit states `claimed → launching → launched → outcome`; transactional persist + fsync BEFORE launch; defined crash recovery (a claim with no recorded launch/outcome is terminal-indeterminate, never auto-replayable). Test: two simultaneous dispatches (exactly one claims), broker restart at each transition, crash after spawn before outcome.
- **MAJOR — approval binds the FULL 256-bit digest.** The verbatim payload stores + the broker compares the full sha256; "sha256 short" is display-only with an unambiguous full-digest expansion. (A shortened authoritative digest invites collision substitution.)
- **MAJOR — catalog aliases are bound to a host-pinned destination + identity, not just a name.** OQ-B, tightened: each catalog credential alias is host-bound to an allowlisted service origin, account/identity, and protocol for its template. Destinations are canonicalized at approval AND dispatch; redirects / alternate credential endpoints are rejected; project config may NARROW but never WIDEN allowed agents beyond a host-pinned policy. The resolved origin + identity render in the approval payload. (Pinning the alias name alone still lets a project-authored destination send `npm-token` to an attacker registry — an exfil primitive.)
- **MAJOR — docker-push leaves the clean file-upload set.** A tag is mutable and a multi-platform index can publish a different graph than approved. docker-push (and any registry push) moves to the digest sub-phase: resolve + lock the full manifest/index graph, push by digest-addressed immutable reference (never a tag), and VERIFY the remote registry digest after push. Until that's implemented it is advisory + provenance-recorded, like the state templates. The clean Phase-1–3 hard-gate set is: npm-publish (packed tarball), vsix-install, generic-upload.
- **MAJOR — the dirty-tree exception is a closed-schema manifest, never a boolean override.** `dirtyArtifacts` allow-with-manifest binds a host-computed manifest of every relevant path + digest (staged before approval), rendered verbatim in the approval. A plain boolean `warn/allow` that lets packaging-influencing files change unrecorded reopens exactly the source→artifact ambiguity the clean-flag exposes.
- **MAJOR — Phase 4 must traverse a REAL destination class + protected identity.** A synthetic webhook rejecting an unrecorded digest is formally green but operationally vacuous. The e2e drives one supported outward template through its actual destination class + protected release identity and shows the corresponding real consumer rejects the unrecorded digest and accepts the recorded one. Destinations left advisory are recorded explicitly.
- **MINOR — the approval binds the resolved POLICY digest, not just `declarationHash`.** A Tachyon update can change a catalog entry's executable/wrapper/binding semantics without touching tachyon.yml, so `declarationHash` alone lets an old approval authorize materially different execution. The approval-bound hash includes a digest of the resolved catalog entry + wrapper + binding semantics + broker policy version; dispatch is rejected if any component changed since approval.

## Verify / Dogfood (declared in tasks.md)

Per-phase behavior tests are the verify surface; the Phase-4 e2e (consumer rejects an unrecorded digest) is the dogfood. Declared as `**Verify:**` / `**Dogfood:**` lines in `tasks.md` when this plan is decomposed.
