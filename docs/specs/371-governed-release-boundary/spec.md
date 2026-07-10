# 371 — governed-release-boundary

_Created 2026-07-10. Task: t-a1faec. Revised after codex adversarial dueto (.tachyon/reviews/371-governed-release-boundary-codex.md — 4 BLOCKER + 10 MAJOR). OQ-0 RATIFIED by maintainer 2026-07-10: Option 1 (Tier A ships now, Tier E additive)._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

> **RATIFICATION (2026-07-10, maintainer):** OQ-0 resolved → **Option 1**. Ship **Tier A (audit-only)**
> now — the sanctioned brokered+approved path, first-class artifact provenance, raw-command detection,
> and the off-machine consumer forcing function — honest that a shared-UID box has NO on-machine
> prevention. **Tier E (enforced credential custody) is a later, additive project** gated on an OS-level
> isolation substrate; the spec must never claim raw shipping is prevented until that conformance check
> exists. The build proceeds to the plan/tasks phase on this basis.

> **Origin:** the product feature underneath the 2026-07-09 self-deploy incidents. Split from t-d0fc4f
> (dogfood-only). Serves ANY project Tachyon orchestrates; sits on the moat: governed delegation.
>
> **Dueto outcome (2026-07-10):** the first draft claimed a UNIVERSAL ENFORCED boundary. The adversarial
> review proved that claim false on the actual deployment model (agents share one OS user on a WSL box):
> a same-UID agent with arbitrary shell can read any host credential the broker materializes (files,
> `/proc`, credential-helper sockets, keychain), so "the credential never reaches the agent" is
> organization, not isolation. **This spec is reframed: enforcement is TIERED and gated on a host
> isolation conformance check; without it the feature is AUDIT-ONLY and must not claim to prevent raw
> shipping.** The four blockers are folded below.

## Intent (reframed — honest scope)

**The failure to prevent:** an agent ships an artifact to prod outside the reviewed pipeline. Tachyon
addresses this at the STRONGEST tier the deployment actually supports, and states which tier is active —
never overclaiming.

**THE INVARIANT (Tier E — Enforced, requires isolation):** an artifact leaving the machine goes ONLY
through a brokered outward action that (a) is bound to a human approval, (b) requires an integrity-valid
PASSING verification record for the exact commit shipped, and (c) transmits ONLY broker-staged bytes
approved in that request. Available only when the host isolation conformance check passes (agents run
under a distinct principal from the credential-bearing broker).

**THE FALLBACK (Tier A — Audit-only, shared-UID default):** Tachyon cannot prevent a same-UID agent from
shipping. It provides governed + human-approved BROKERED paths as the sanctioned route, records
first-class artifact provenance, and DETECTS raw outward commands as advisory evidence. The real
enforcing boundary in this tier lives OFF the machine (registry/CI/cluster admission comparing the
received digest to recorded provenance — Phase 4). The spec says so loudly and ships a forcing function
that FAILS if any doc or UI string claims raw shipping is prevented in Tier A.

Everything below composes existing machinery: evidence channel (273/274), host-action broker
(default-deny, hashed audit), approval protocol (t-7d8bdf, host-side resolve), verification records.

## Threat model & deployment tiers (new — the fork the maintainer must pick)

| | Tier A — audit-only (today's WSL box) | Tier E — enforced (isolated) |
|---|---|---|
| Agent principal | same OS user as broker | distinct user / container / VM |
| Credential custody | NOT a boundary (same-UID reads it) | real — agent cannot read broker fs/proc/sockets |
| What stops raw ship | nothing on-machine; off-machine consumer gate | credential custody + broker-only path |
| Claim Tachyon may make | "sanctioned path + provenance + detection + off-machine gate" | "raw shipping prevented" |
| Conformance gate | none required | host isolation check MUST pass to enable Tier E |

**This is OQ-0, the ratification fork:** does Tachyon (1) ship Tier A now and treat Tier E as a later
isolation project, or (2) block the whole feature until an isolation substrate exists? The rest of the
spec is written so Tier A ships real value (provenance + brokered path + off-machine forcing function)
and Tier E is an additive conformance gate, not a rewrite — but the maintainer picks the framing.

## The three original questions — answered

### Q1 — How does a project declare outward-facing commands?

`tachyon.yml` under `settings.releaseBoundary.outward[]` (precedent: `settings.gitDelivery`), NOT
inference, NOT a separate file. **A declaration is a REQUEST that NARROWS a build-pinned trusted policy —
it never GRANTS executable authority** (folds MAJOR-5). Concretely:

- Tachyon ships a **build-pinned catalog of outward action TEMPLATES** (npm-publish, docker-push,
  vsix-install, kubectl-apply, terraform-apply, generic-upload) in the hashed external policy — the
  executable, wrapper implementation, credential CLASS, and per-capability binding semantics are fixed
  in core, not project-authored.
- `settings.releaseBoundary.outward[]` may only SELECT a template + narrow it (restrict args, pin a
  destination allowlist, name which credential alias, list allowed agents). It cannot introduce a new
  executable, a new interpreter, or a credential-bearing command not in the catalog. A project entry
  naming an unknown template → config error.
- The parsed `releaseBoundary` snapshot is canonicalized + hashed at config load. **At BOTH approval
  time and dispatch time the broker independently RELOADS + recanonicalizes the effective release config
  from disk** (folds MAJOR-10) — following includes/symlinks, rejecting duplicate keys — and binds the
  full semantic capability definition, not just a cached hash. Mismatch between approval-bound and
  dispatch-time definition → `policy_version_mismatch` denial.

### Q2 — Enforced vs advisory: what actually stops a raw `npm publish`?

Stated per tier, no overclaim:

1. **Tier E only — credential custody as a boundary.** Enforceable ONLY when agents run under a
   principal that cannot read the broker's filesystem, process environment, `/proc`, credential-helper
   sockets, or keychain. On a shared-UID box this is FALSE and the spec says so (folds BLOCKER-1). The
   conformance test proves the agent cannot retrieve the credential before/during/after dispatch — not
   merely that it's absent from the harness env.
2. **Both tiers — the brokered path.** `run_host_action("outward.<name>")`: default-deny, closed-schema
   args, hash-chained audit, and NEW preconditions for the outward class, all host-side (d737c90
   template):
   - **Caller MUST be an agent-token-resolved principal.** Legacy/self-declared callers are rejected on
     BOTH approval creation AND dispatch (folds BLOCKER-2 — the existing `StaticHostActionPolicy`
     already rejects non-agent callers; the approval requester-match must do the same).
   - **A PASSING, integrity-valid verification record for the EXACT shipped commit is required** (folds
     BLOCKER-3). The broker reads `.tachyon/verifications/<refSha>.json` itself, checks `verdict:accept`
     + `integrityHash` + `refSha === provenance.commit`. Absent/failed/stale/mismatched → denied.
     Evidence stays non-gating (273 rule intact); THIS gate is the broker precondition, not evidence
     severity. A `break-glass` capability (separate template, its own audit class + louder approval) is
     the only unverified path.
   - **Bind what TRANSMITS, not just a hash** (folds BLOCKER-4 — the deepest). Per-template binding
     semantics, because most outward actions don't ship one file:
     - *file-upload templates* (vsix-install, generic-upload, npm-publish tarball): the broker COPIES
       the approved bytes into a broker-owned immutable staging path at record/approval time and
       executes ONLY against that staged object — closing the record→dispatch swap race.
     - *context/state templates* (docker-push, kubectl-apply, terraform-apply): approve a
       platform-native immutable DIGEST or a complete host-computed manifest, not a file sha256; the
       wrapper validates the pushed/applied digest equals the approved one and constrains destination.
   - **Destination + release identity are part of the binding** (folds MAJOR-12): the approval payload
     and broker validation include registry/cluster/account/environment, package/tag/version, wrapper
     version, normalized args, and credential alias — hash equality of bytes ≠ action equality.
   - **Single-use, atomic claim** (folds MAJOR-11): approval transitions approved → claimed atomically
     BEFORE process launch; concurrent claims rejected; terminal outcome recorded separately. Retry is a
     new approval unless the template proves idempotency via a destination operation id.
3. **Both tiers — detection, NO completeness claim** (folds MAJOR-8). Declared `command` shapes become
   detection patterns for HONEST literal invocations only; the spec explicitly states detection is
   evadable (absolute paths, aliases, renamed binaries, SDKs, curl, SSH, CI triggers) and makes NO
   coverage claim. Tests assert only the exact documented pattern fires + include evasion fixtures that
   are expected NOT to fire, so no misleading green.

### Q3 — Artifact from a dirty tree?

**Default `refuse` for governed release** (reversed from the first draft — folds MAJOR-9). Warn-and-show
degrades to a rubber stamp: a file COUNT + status head doesn't tell a busy approver whether the dirty
bytes are reviewed source, generated output, or injected junk, and repeated DIRTY cards normalize
approval — severing the "traceable to a reviewed commit" claim. A dirty release requires an explicit
exception flow (`dirtyArtifacts: allow-with-manifest`) that binds a COMPLETE host-computed diff +
untracked/ignored/submodule state + the staged immutable artifact, under a distinct approval reason and
audit class. `refuse` is the default; plain `warn` is removed.

## What ships (Tier-A-first, Tier-E-additive)

- **Phase 1 — `artifact-provenance` evidence kind + `record_artifact_provenance` Bridge tool.** Host
  fills everything trust-bearing (sha256 host-computed from the file, commit/treeSha/clean host-read,
  verification host-read, `producedBy` = Bridge-resolved caller); caller supplies only a
  traversal-checked path + optional summary. **The artifact IS staged into a broker-owned
  content-addressed store** (folds MAJOR-6) with a size cap / streaming — a hash without retained bytes
  is an identifier, not recoverable provenance. Cheap, unblocks the rest, useful in BOTH tiers.
- **Phase 2 — `outward` capability class.** Build-pinned template catalog + project narrowing (Q1);
  broker preconditions (Q2 layer 2). Two policy sources compose; audit records which authorized.
- **Phase 3 — approval binding.** Payload embeds the full canonical action definition + provenance +
  destination/identity (Q2); host-side validation at dispatch; single-use atomic claim; resolve stays
  host-side only (anti-laundering rule untouched).
- **Phase 4 — off-machine forcing function (the REAL Tier-A boundary).** Reference consumer gates
  (registry admission webhook, protected CI release identity, cluster admission, immutable-digest
  allowlist) that REJECT an artifact whose digest isn't in recorded provenance. Ships as docs + a
  reference implementation AND at least one wired forcing function in the dogfood/e2e suite that fails
  when an unrecorded digest is accepted — so Tier A has teeth off-machine, not just documentation.
- **Phase 5 (Tier E, gated) — isolation conformance check.** A host check proving agent-principal
  cannot read broker credential material; enables the Tier-E credential-custody claim. Out of scope to
  BUILD the isolation substrate here (that's a separate project) — this phase only defines the gate and
  refuses the Tier-E claim until it passes.

## Non-goals

- Shell confinement/interception as security (porous; detect, no completeness claim).
- Project-authored executables or credential-bearing commands (catalog-only; declarations narrow).
- Building the OS-isolation substrate (Tier E depends on it; not built here).
- Replacing the verify gate (evidence stays advisory; the broker independently re-reads verification).
- A vault/secrets manager (custody placement only; value stays in host keychain/secrets.env).

## Acceptance criteria (adversarial — each is a forcing function)

- [ ] **Same-UID custody honesty:** in Tier A, a test asserts the docs/UI do NOT claim raw shipping is
  prevented; the Tier-E credential-custody criterion is SKIPPED (not silently passed) when the isolation
  conformance check is absent.
- [ ] **Legacy-caller spoof fails:** approval creation AND outward dispatch reject a legacy/self-declared
  caller through every Bridge entry point (fuzz the identity param).
- [ ] **Verification required:** outward dispatch with absent / failed / stale / wrong-refSha /
  tampered-integrityHash verification → denied; only `verdict:accept` for the exact shipped commit
  proceeds; break-glass is a separate audited capability.
- [ ] **Transmit-binding, no swap race:** file-template execution runs against the broker-staged
  immutable object; replacing the source file after record does NOT change what ships; a state-template
  push/apply validates the approved digest and rejects a substituted destination/context.
- [ ] **Destination binding:** same bytes approved for registry-test cannot dispatch to registry-prod;
  the payload renders destination/account/version/wrapper-version verbatim.
- [ ] **Single-use atomic:** two concurrent dispatches of one approvalId → exactly one claims, the other
  denied; a crashed dispatch does not silently free the approval.
- [ ] **Dirty refuse-by-default:** a dirty-tree artifact is refused unless the explicit manifest
  exception flow is used; plain `warn` does not exist.
- [ ] **Declaration binds semantic config:** an edit to `releaseBoundary` between approval and dispatch
  (including via an included/symlinked file) is caught by the independent dispatch-time reload; unrelated
  edits don't spuriously deny (normalization test).
- [ ] **Provenance host-computed + retained:** caller-supplied hash/commit is impossible by construction
  (no such params); the staged bytes are retrievable for post-incident comparison.
- [ ] **Off-machine forcing function:** the dogfood/e2e suite fails if a consumer gate accepts an
  artifact digest absent from recorded provenance.
- [ ] **Detection has no completeness claim:** the pattern test fires on the exact documented command and
  the evasion fixtures are asserted NOT to fire (so green never implies coverage).

## Open questions (for ratification)

- **OQ-0 (THE FORK) — RESOLVED (maintainer, 2026-07-10): Option 1.** Ship Tier A now (audit-only +
  off-machine forcing function, honest about no on-machine prevention on a shared-UID box); Tier E is a
  later additive project gated on an isolation substrate. The remaining OQs below are for the
  implementation plan, not blocking the design.
- **OQ-A:** outward execution via `HostActionPort` (VS Code adapter) or a broker-owned child process with
  the injected credential? (Lean: broker-owned process — CLI-shaped, and it's where staging + credential
  materialization + `/proc` exposure all live, so Tier E isolation attaches here.)
- **OQ-B:** credential mapping — declaration names WHICH credential alias (`credential: { env: VSCE_PAT,
  from: host }`); the VALUE stays in host keychain/secrets.env, never tachyon.yml. Confirm the alias set
  is catalog-pinned, not project-open.
- **OQ-C:** for state templates (kubectl/terraform), is a platform-native immutable digest always
  available to bind, or do some require a host-computed manifest the consumer can't independently verify?
  (Determines whether those templates are Tier-E-only.)
