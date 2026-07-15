# 377 — agent-soul-identity — notes

_Created 2026-07-13. Append-only after this planning checkpoint._

## Design decisions

### 2026-07-13 — draft recommendations, pending ratification

- Identity must remain distinct from `role`. Spec 216 explicitly defined role templates as reusable
  task contracts and excluded persona prompting; this feature adds the missing layer rather than
  changing that meaning.
- Original draft: use one explicit workspace-relative file reference, optionally shared. Superseded
  by the 2026-07-14 maintainer direction below: `soul: true` activates only the canonical managed
  `.tachyon/agents/<agent>/SOUL.md` copy.
- Resolve from the coordinating workspace root. Worktree/cwd resolution would let an executing
  branch alter its own control context on restart or re-anchor.
- Preflight identity before worktree/Delivery/pane side effects; a bad edit must not consume a
  lease or replace a currently healthy process.
- Keep the current primer at the opening and before-finishing at the end. Soul is a body layer, not
  a new provider-level system prompt.
- Separate current execution task from persistent `instructions`. The present
  `appendInstructions` mutation makes precedence and re-anchor reconstruction impossible to prove.
- Use the existing verified opening-prompt adapters in phase 1. Unsupported delivery is a blocking
  error for `soul`, unlike the legacy compatibility warning for `instructions`.
- Do not materialize Hermes `SOUL.md` until Tachyon owns a safe per-agent Hermes home/profile
  lifecycle. Never write ambient `~/.hermes/SOUL.md`.
- Reload on fresh spawn/restart/re-anchor. Resume, host rebind, and native fork retain transcript
  identity without duplicate injection.
- Treat soul as trusted workspace configuration and explicitly not secret storage or an authorization
  boundary. Do not add heuristic prompt-injection scanning.
- Fail on invalid/oversize content; never truncate identity.
- Preserve exact no-soul bytes with a legacy serializer: typed `taskBrief` is concatenated with
  persistent instructions only at render time, before Bridge guidance. Soul-enabled prompts alone
  adopt task-after-Bridge order.
- Record identity as `offered` with a channel, never as proof that the model consumed it. Failed
  compaction recovery records `identity-degraded` and visible attention.
- Raw source bytes are the payload/digest; no CRLF or whitespace normalization. The dual cap has
  separate semantic-length and I/O rationales.
- Keep current short-inline/long-file transport for delivery strength, with argv exposure explicitly
  ratified and soul prohibited for confidential content.
- Deterministic identity preflight failures stop unattended retry loops rather than starting without
  identity.

## Investigation log

### 2026-07-13 — Tachyon composition and lifecycle

- `ManagedEntryDef` currently stores `instructions` and `role` only.
- `composeInstructions` renders role then explicit instructions. `withBridgeGuidance` appends the
  coordination tail.
- `AgentManager.effectiveCmd` passes the flattened body through `deliverableBody`, prepends the
  generated primer, appends before-finishing, and finally delegates to `composeCommand`.
- Pipeline and bound Delivery objectives currently mutate a copied `def.instructions` through
  `appendInstructions`.
- Opening prompt delivery exists for Claude, Codex, Agy, Gemini, OpenCode, and Grok.
  `instructionsDeliverable` currently checks token zero while `composeCommand` uses
  `resolveBinary`, so launcher-wrapped warning behavior can disagree with actual delivery.
- Long bodies over 4,000 characters are written to
  `.tachyon/briefs/spawn/<agent>.md`; the pane gets a bounded pointer plus primer.
- Restart recomposes through `effectiveCmd`. Resume intentionally does not recompose instructions,
  because the runtime transcript already contains the opening brief. Host rebind calls resume with
  primer injection disabled.
- Native fork carries transcript context and does not render a new opening brief.
- Re-anchor writes role/instructions to `.tachyon/roles/<agent>.md` and injects a pointer plus the
  primer envelope.
- The current relative re-anchor pointer is not readable from every isolated worktree. Soul-aware
  anchors require a shell-safe absolute coordinator path; this also needs a regression test with
  spaces.
- `deliveryDefinitionSnapshot` clones the declared definition, so a future `soul` field naturally
  survives unless explicitly stripped.
- `SessionLedger` persists ad-hoc restart input and resume metadata but has no typed role, identity,
  or one-run task layer.

### 2026-07-13 — Agent Studio

- The current surface labels `instructions` as “Instructions (role prompt)”, reinforcing the
  identity/role ambiguity this feature must remove.
- The browser shell cannot read files directly; filesystem actions must use typed host domain
  messages through `AgentStudioPanel`/`AgentStudioAdapter`.
- The existing domain action is a cwd folder picker. Soul needs separate import/create/open/preview
  actions, not an overloaded browse reply; import copies into the canonical profile.
- Full soul editing should remain in the Markdown editor so Agent Studio does not create a second
  unsaved source of truth.

### 2026-07-13 — runtime/upstream evidence

- OpenClaw documents `SOUL.md` as persona/tone/boundaries and `AGENTS.md` as operating instructions;
  workspace files are loaded into session context and must not contain secrets.
- Hermes documents `$HERMES_HOME/SOUL.md` as its primary identity block and loads it ahead of other
  user context. Installed Hermes Agent v0.18.2 exposes `--ignore-rules` to skip `AGENTS.md`,
  `SOUL.md`, memory, and skills, plus isolated profiles, but no verified generic interactive
  startup-prompt argument.
- The official Codex manual documents global/project `AGENTS.md` hierarchy assembled for a launched
  run and no native `SOUL.md` slot. Tachyon therefore must not describe its Codex soul as a native
  system-prompt feature.

## Alternatives considered

| Alternative | Benefit | Rejection / deferral reason |
|---|---|---|
| Reuse `instructions` | Zero schema/code change | Keeps identity and operational specialization indistinguishable; cannot support clear lifecycle/Studio UX |
| Inline `soul: | ...` | Simple YAML | Duplicates `instructions` under a new name, poor Markdown editing/reuse, bloats config |
| Implicit root `SOUL.md` | Familiar upstream convention | Creates global hidden inheritance and worktree drift; not per-agent |
| Arbitrary workspace-relative soul reference | Reuse/version any file directly | Rejected by maintainer: fragments agent configuration and gives future persistence no canonical subtree |
| Implicit `.tachyon/agents/<agent>/SOUL.md` discovery | No config field | A retained/remote-restored file could unexpectedly activate identity; explicit `soul: true` keeps old configs inert |
| Keep the selected import source linked | No duplicate local file | External edits/path availability would bypass canonical ownership and future sync; import must copy and discard the source path |
| Top-level named `souls:` registry | Reusable aliases/defaults | Adds inheritance/profile semantics before a single source model is proven |
| Array/includes of identity files | Composable | Introduces ordering, cycle, provenance, and limit complexity |
| Materialize native files for every runtime | Potentially higher-priority context | Each runtime has different path, reload, profile, and priority rules; Claude/Codex files also carry repo instructions |
| Write Hermes ambient SOUL | Immediate native support | Global mutable user state, concurrency clobber, auth/profile ownership violation |
| Delayed terminal `sendKeys` for unsupported runtimes | Broad apparent coverage | Racy, spends a turn, is not opening identity, and can collide with human input |
| Silent truncation | Always starts | Can remove the most important behavioral limits and makes digest/preview misleading |
| Prompt-injection keyword scanner | Reassuring UI | Cannot establish safety, creates false positives/negatives, and distracts from trust/authority controls |

## Deviations

- Planning is being performed in isolated worktree
  `/home/goat/tachyon-worktrees/t-60979d` on branch
  `codex-soul/t-60979d-agent-soul-identity`.
- This task intentionally changes only SDD documents. No production or test code is authorized
  before ratification.

## Tradeoffs

- Strict per-agent scope is less convenient than a global default but keeps identity explicit and
  makes two-agent behavior auditable.
- Coordinator-root resolution means an identity edit made only in an agent worktree does not take
  effect until integrated. That friction is intentional: the executing agent cannot self-modify its
  next identity injection.
- Canonical import duplicates the selected file once. That cost is intentional: afterward
  `.tachyon/agents/<agent>/SOUL.md` is the only live source, making backup/sync/rename ownership
  deterministic.
- Keying the v1 profile directory by validated agent name makes rename a filesystem transaction.
  A minimal Tachyon-owned manifest therefore assigns a random stable `profileId` now; it prevents
  silent same-name inheritance without defining any future remote-persistence protocol or schema.
- Prompt composition gives consistent Tachyon semantics but not native system-prompt priority.
  Product copy must stay honest about that distinction.
- A metadata digest helps audit which version a transcript received, but v1 deliberately avoids
  background watching and “stale soul” badges unless they can be added without a new file watcher.
- Keeping exact no-soul rendering requires a compatibility branch in the compositor. Removing it
  would simplify code but silently rewrite every existing agent's opening prompt.

## Review log

### 2026-07-14 — maintainer storage direction

- The maintainer rejected arbitrary workspace soul references and directed Tachyon to centralize
  durable agent identity under `.tachyon` for future local/remote persistence.
- Repository inspection confirmed no `.tachyon/agents/` root exists. Existing
  `.tachyon/harness/<agent>`, `.tachyon/roles/`, and `.tachyon/continuity/` have runtime-home,
  generated-contract, and working-state ownership respectively, so none is an appropriate profile
  root.
- `.tachyon/transactions/` is also unavailable: plugin tool provisioning owns its journal schema and
  TTL GC, which can reclaim unknown directories. All profile mutations therefore use the isolated
  `.tachyon/agent-profile-transactions/` root.
- Revised R1/R5 use boolean soul enablement plus
  `.tachyon/agents/<agent>/SOUL.md`. Agent Studio imports an exact copy into that path, never retains
  the original path, and uses confirmed/transactional replace, rename, and delete behavior.
- V1 deliberately leaves operational config in `tachyon.yml` and implements no remote sync; the new
  directory is the stable persistence boundary those later features can adopt.

### 2026-07-13 — independent Claude adversarial review

- First probe `probe-cbac272c-b4ac-451b-a2a5-93b8695172af` timed out at 120 seconds without an
  artifact.
- Reduced read-only retry `probe-b6edc9ba-603a-4f55-ab7a-2e35c355ac09` completed on Claude Code
  2.1.207 with a `NO-SHIP` verdict (cost reported by the probe: USD 0.647462).
- Findings: 2 blockers, 5 majors, 5 minors. The durable raw result remains under
  `.tachyon/probes/probe-b6edc9ba-603a-4f55-ab7a-2e35c355ac09/result.json` in the coordinator
  workspace.

| Finding | Resolution in this draft |
|---|---|
| BLOCKER: byte-identical no-soul promise contradicted task-after-Bridge R6 | Corrected legacy renderer to serialize instructions+task before Bridge; canonical new order is soul-enabled only; golden snapshots required |
| BLOCKER: TOCTOU/digest timing undefined | POSIX no-follow descriptor read/hash, honest documented Windows residual race, exact-byte payload/digest, and channel-specific `offered` state after handoff |
| MAJOR: invalid soul can outage crash/scheduled work | Outage is now explicit: deterministic retries stop, attention latches, execution fails before acquisition, and there is no silent fallback |
| MAJOR: wrapped runtime detection unspecified | Pinned `resolveBinary` syntax, recognized launchers, wrapper/renamed-binary failure, and no v1 override |
| MAJOR: failed re-anchor leaves silent identity loss | Added durable `identity-degraded`, attention, retry suppression, and visible A→B transitions |
| MAJOR: argv privacy contradiction | Accepted as a ratification tradeoff for reliable opening delivery; moved to trust model, prohibited secrets, and documented forced-file alternative |
| MAJOR: CRLF/Unicode/path semantics undefined | Raw bytes/no normalization, Unicode scalar count, forward-slash config paths, and explicit CRLF digest difference |
| MINOR: terminal rejection vague | Rewritten as concrete `terminals:`/`kind: terminal` and type-shape assertions |
| MINOR: dual limit lacked rationale | Added upstream/semantic character rationale plus byte I/O bound and measured error requirements |
| MINOR: Hermes failure implicit | Hermes now explicitly fails closed for Tachyon soul in phase 1 |
| MINOR: derived-file retention missing | Added gitignore, overwrite, stop/resume retention, and permanent cleanup contract |
| MINOR: OpenCode prefill oversold | Classified as `offered/tui-prefill`, not proof of submission/consumption |

The original NO-SHIP blockers/majors are addressed in the SDD text. Maintainer ratification of
`R1`–`R6` remains pending.

### 2026-07-13 — focused follow-up review

- Probe `probe-84500d88-372f-4ded-a92d-d31f0968c1e4` completed on Claude Code 2.1.207 with a
  narrowly scoped `NO-SHIP` verdict (cost reported by the probe: USD 0.791190).
- It confirmed both original blockers and all five original majors were resolved, then identified
  three residual verification/taxonomy majors; no new design-level blocker or major was introduced.

| Residual finding | Resolution in this draft |
|---|---|
| Golden baseline provenance was unspecified | Fixtures are pinned to exact commit `23130cea1c1cf8046c1b09ac306de80d92c1bb0e`; manifest/per-fixture guards fail on drift and expectations never come from the new renderer |
| Byte compatibility did not cover every composition path | Golden coverage includes fresh spawn, restart, no-soul re-anchor, bound Delivery/pipeline tasks, existing short/long transport, and exact resume/rebind/fork outputs plus all-compositor bypass spies |
| Deterministic/transient preflight taxonomy was undefined | Stable resolver errors carry explicit retryability; enumerated deterministic failures latch immediately, while only enumerated transient errors retry at 2s/4s/8s before latching |

That corrected text was submitted to the further closure pass recorded below.

### 2026-07-13 — closure-contract review

- Probe `probe-783818af-310b-4907-9743-82f97c30261c` completed on Claude Code 2.1.207 with `NO-SHIP`
  (cost reported by the probe: USD 0.384426).
- It found six remaining majors in the wording of the baseline and retry contracts; all are closed
  in the current SDD without changing R1–R6.

| Finding | Resolution in this draft |
|---|---|
| `BASE_SHA` was descriptive rather than one pinned commit | Pinned immutable `23130cea1c1cf8046c1b09ac306de80d92c1bb0e`; manifest and every fixture must match it under a failing test |
| Legacy and new-feature fixtures could be conflated | BASE_SHA parity covers only no-soul behavior, including the already-existing short/long transport; soul-enabled characterization has a separate non-parity suite |
| Resume/rebind/fork bypass spies did not prove byte parity | Added exact BASE_SHA command/send-key fixtures plus the stronger invariant that no prompt serializer, resolver, or brief compositor is called |
| Error classification had no default | Every unknown error now defaults to deterministic/fail-closed; only the explicit retryable allowlist can back off |
| Replace-race detection conflicted with deterministic `ENOENT` | Replaced it with concrete same-handle double-read/stat `source-changed-during-read`; atomic rename preserves the open handle and bare open-time `ENOENT` stays `missing` |
| Human restart transient behavior was undefined | Human restart follows the bounded non-blocking schedule, preserves the live process until successful preflight, and surfaces/latches exhaustion |

One final review is limited to verifying these six closures; it is not an invitation to reopen
accepted product tradeoffs.

### 2026-07-13 — final edge-case review

- Probe `probe-c8e7d030-1a22-45f5-be47-dea45c32a849` completed on Claude Code 2.1.207 with one
  remaining major (cost reported by the probe: USD 0.434656).
- It confirmed the six prior closure areas except for an oversize-classification edge: a bounded
  read could make a stable file above 64 KiB look like a retryable size mismatch.
- The resolver contract now checks descriptor size and the cap+1 sentinel before change detection;
  stable oversize input returns deterministic `too-many-bytes` with zero retry. Only within-cap
  observations may become `source-changed-during-read`.

### 2026-07-13 — independent closure verdict

- Micro-probe `probe-cb7693c2-46b0-4681-868d-7996ce7c2aa9` completed on Claude Code 2.1.207 with
  `SHIP`, zero findings (cost reported by the probe: USD 0.198503).
- It confirmed that stable descriptor oversize and either-read sentinel overflow are deterministic
  zero-retry outcomes checked before the retryable source-change branch. No blocker or major remains
  in the reviewed SDD contract.
- This is a planning judgment, not implementation evidence; the future diff, BASE_SHA fixtures,
  targeted tests, dogfood, and repository gate remain mandatory.

### 2026-07-14 — canonical-profile adversarial review

- Initial probe `probe-8d270d12-42aa-4ca3-bcc1-1e8a8e382c5c` timed out at 120 seconds without an
  artifact.
- Reduced read-only probe `probe-84fd3239-faa1-46c4-88c4-6481f046582b` completed with seven majors
  and one minor (cost reported by the probe: USD 0.400075). It reviewed only the maintainer-directed
  `.tachyon/agents` revision, not previously ratified product tradeoffs.

| Finding | Resolution in this draft |
|---|---|
| Retained profile could be inherited when an agent name is reused | Added Tachyon-owned `profile.json` with random stable `profileId`, owner, schema, and `active|retained`; retained/missing/unknown ownership is inert until explicit digest-backed adoption |
| Whole-`tachyon.yml` transaction hashes make unrelated edits block recovery, and degraded state had no exit | Journals compare only affected stanza hashes/name presence, profile ID, paths/digests, and phase; a confirmed Repair action can Complete or Roll Back a provably reconcilable journal |
| Only rename was serialized against lifecycle, leaving import/replace/delete races | Every profile mutation shares one admission lock with spawn/restart/re-anchor; Replace uses digest CAS, delete rechecks sessions, and lifecycle records a short-lived launch reservation |
| Case-only rename temp state/collision semantics were incomplete | Journal records the unique temporary sibling before the first move and exempts only the same folded-name/profile ID while rejecting a distinct destination profile |
| Atomic replace did not define power-loss durability | Stage on the destination filesystem, quarantine and verify the confirmed old digest with separate rollback bytes, publish no-replace, flush file/directory on POSIX or use/document the strongest Windows primitive, then reopen strictly and verify before config/manifest commit |
| `soul` values other than `true` were underspecified and `false` was unnaturally invalid | R1 is now an optional boolean: `true` enables, `false`/absence disable, and non-booleans follow the existing whole-config rejection/last-known-good contract |
| ASCII lowercase uniqueness could be weaker than general filesystem case folding | Existing agent names are explicitly ASCII-only, so ASCII lowercase covers the complete accepted alphabet; transactions also reject distinct active/retained manifests with the same fold, while case-only moves of the same profile use the journaled temporary sibling |
| Permanent profile deletion could be blocked forever by resumable rows | Studio links to permanent Dismiss/session purge or offers a separately second-confirmed combined purge-and-delete action; the lock rechecks no live session and cleared resume pointers |

All eight findings are incorporated across `spec.md`, `plan.md`, and `tasks.md`; the narrow closure
pass is recorded below.

### 2026-07-14 — canonical-profile closure verdict

- Probe `probe-6269b5ff-9ac7-42fa-b617-67c37df216f8` was non-substantive because its bounded
  environment could not read the isolated worktree (cost reported by the probe: USD 0.063423).
- Inline-excerpt retry `probe-8d67473a-effd-4541-a29a-ac7de18c21f2` timed out at 120 seconds without
  an artifact.
- Micro-probe `probe-3ebe1bca-3107-4ece-812e-221e6dd2bf8c` reviewed the authoritative eight-item
  closure matrix on Claude Haiku 4.5 and returned `SHIP` (cost reported by the probe: USD 0.051219).
- It found the boolean lifecycle, active/retained ownership, transaction journal/repair, shared lock
  and launch reservation, case-fold/case-only rename rules, durable no-replace publication, and
  bounded purge-before-delete contract mutually consistent. No blocker or major remains in this
  planning revision; implementation evidence and maintainer R1–R6 ratification remain pending.

### 2026-07-14 — maintainer ratification

- The maintainer replied “está aceito” to the presented complete revised R1–R6 bundle.
- R1–R6 are locked without amendments on 2026-07-14. This resolves the planning gate but does not
  itself start production/test implementation; bounded implementation Deliveries remain the next
  coordination step.
- Planning task `t-60979d` is complete once this ratification record is committed and verified.

### 2026-07-14 — implementation-base refresh

- The isolated integration worktree was created from current `main` at
  `6885becd72dbd1a4eed270a3233f5d8e0a3e310e`, then received the three ratified SDD commits.
- Since the original planning snapshot, current main changed legacy composition/lifecycle seams in
  `AgentManager`, `loadConfig`, resume adapters, role templates, and `Workspace`. Capturing parity
  against the older SHA would therefore reject the current pre-feature tree or freeze obsolete bytes.
- The live spec/plan/tasks now pin `BASE_SHA` to `6885becd72dbd1a4eed270a3233f5d8e0a3e310e`.
  Earlier references to `23130cea1c1cf8046c1b09ac306de80d92c1bb0e` in the historical review log
  describe the planning-time review only and are superseded for implementation fixtures.
- This is a compatibility-baseline refresh, not an amendment to ratified R1–R6. The refreshed base is
  green under `npm run typecheck` and `npm run verify:full:quiet` (333 files; 4035 passed, 3 skipped).

### 2026-07-14 — T1–T4 foundation integrated

- Task `t-eb926c` was implemented and reviewed in isolated worktrees, then squash-integrated as
  `a55167b6` on `codex-soul/t-60979d-agent-soul-integration`. The accepted candidate HEAD was
  `f25a521e`.
- T1 now stores real `BASE_SHA=6885becd72dbd1a4eed270a3233f5d8e0a3e310e` prompt, command, and
  send-key bytes with per-fixture provenance. The capture helper refuses after a legacy seam changes,
  and actual resume, rebind, and native-fork tests consume the oracle while asserting the composition
  and soul-resolution boundaries are bypassed.
- T2 adds agent-only boolean `soul`, terminal/non-boolean rejection, last-known-good retention,
  ASCII-folded enabled-name collision checks, schema/YAML coverage, canonical path helpers, and the
  two machine-local ignore roots.
- T3 adds strict descriptor-based resolution, active same-owner private manifests, exact-byte limits
  and digests, total retry classification, private import-as-copy staging, create-only publication with
  manifest-last activation, parent containment, and concurrent no-clobber coverage. This is deliberately
  not the T15 transaction journal/lock/recovery system.
- T4 centralizes launcher parsing and prompt adapters so capability reporting and `composeCommand`
  share one registry. OpenCode reports `tui-prefill` without prematurely claiming `offered`; Hermes
  remains native-external for soul while retaining its legacy instruction-delivery path.
- The canonical Bridge verification record was unavailable after extension-host reloads, so the
  coordinator reproduced the gate explicitly: the generated behavior test failed at `86f4fac9` and
  passed at the accepted HEAD. Final focused verification passed 489 tests; `npm run typecheck` and
  `npm run verify:full:quiet` passed with 337 files, 4066 tests passed, and 3 skipped. Two bounded
  Claude closure probes produced no artifact (timeout, then budget exhaustion), so no model-review
  claim is made for this slice.

### 2026-07-14 — T5–T11 lifecycle slice integrated

- Task `t-dac8d0` was implemented in an isolated worktree and integrated through commits
  `209fbb78` through `f78b2343` on `codex-soul/t-60979d-agent-soul-integration`.
- T5–T8 add typed soul/role/instructions/Bridge/task composition, exact no-soul parity, typed
  `taskBrief`, fail-closed spawn/restart preflight with bounded transient retry, metadata-only launch
  reservations, and fork metadata copying without re-resolving or re-injecting identity.
- T10–T11 add defensive metadata-only ledger parsing and private atomic soul-aware re-anchor files,
  including degradation metadata and compaction retry suppression. No soul body or import path is
  persisted in the ledger or launch reservation.
- T9's declared Delivery, pipeline, schedule, coordinator-root, and non-inheritance lifecycle slice
  is present. Its rename/retention/adoption transaction clause remains deliberately open with T15;
  the T9 checkbox is therefore not closed early.
- The coordinator reproduced the executable gate: the A2 behavior stub failed before production
  changes and passed after integration. Final independent execution passed the 460-test focused
  lifecycle/parity suite, `npm run typecheck`, and `npm run verify:full:quiet` with 338 files,
  4073 tests passed, and 3 skipped. T12, T14, T15, product docs, and dogfood remain out of this slice.

### 2026-07-14 — T12–T13 core hardening integrated

- Task `t-2f380c` was implemented in an isolated worktree and integrated as `2752c577` through
  `da36969a` on `codex-soul/t-60979d-agent-soul-integration`.
- T12 adds same-directory atomic writes for derived briefs and anchors, private `0700` directories
  and `0600` files, UTF-8 byte-ceiling enforcement, cleanup after failed publication, deterministic
  overwrite, and permanent-forget cleanup of generated copies while retaining canonical
  `.tachyon/agents/<agent>/SOUL.md` profiles. Canonical profile mutations and their durable
  rename/delete transactions remain owned by T15.
- The independent Claude-family T13 review found one blocker: Delivery-join and reuse-worktree
  launches returned un-awaited promises from inside the reservation `try/finally`. Commit
  `da36969a` adds the two required `return await` operations and deterministic tests that hold each
  launch pending, observe the live reservation, then prove cleanup after settlement. The closure
  review returned `SHIP` with no remaining blocker or major; no accepted minor was recorded.
- Coordinator verification on the integrated HEAD passed the 381-test focused core/lifecycle/parity
  suite, `npm run typecheck`, and `npm run verify:full:quiet` with 339 files, 4078 tests passed, and
  3 skipped. The integration worktree was clean after removing the verification-only dependency
  symlink.

### 2026-07-14 — T14 Agent Studio enablement integrated

- Task `t-6c328e` was implemented and reviewed in isolated worktrees. Accepted candidate
  `10674d1e` was squash-integrated as `c415ca6d` on
  `codex-soul/t-60979d-agent-soul-integration`.
- T14 adds a two-state **Enable soul** control before Role/Persistent instructions, renames the
  legacy textarea to **Persistent instructions**, defaults every shared `FormState` constructor to
  disabled, reads only literal `true` from existing agent definitions, and writes only literal
  `soul: true` or omission for agent entries. Explicit `false` and absence remain disabled.
- Host validation blocks defined non-boolean values and runtimes without an opening-prompt channel,
  including Hermes/native-external and wrapped commands, while OpenCode/tui-prefill remains allowed.
  Both stable soul issue codes map to actionable Agent Studio messages. Missing `soul` in a pre-T14
  restored draft is accepted as legacy-disabled, so old dirty snapshots remain saveable.
- The executable T14 behavior test failed semantically at the test-only commit `68a99ffc` before
  production changes and passed at the accepted candidate. Coordinator pass-after covered 106 tests
  plus `npm run typecheck`; the candidate full gate passed 340 files, 4084 tests, with 3 skipped.
- The independent reviewer found the legacy-restore and raw-error-message blockers at `927f9d65`.
  Both were corrected in `10674d1e`; the narrow closure review returned `SHIP` with no remaining
  blocker or major. Visual QA at 900x900 returned `SHIP` for new/off and dense-edit/on fixtures with
  coherent layout and the intended ordering/label.
- T15 profile actions, profile transactions, product documentation, and final dogfood remain open;
  no import/create/open/preview/replace/rename/delete/repair behavior was added in this slice.

## Open questions

- Resolved 2026-07-14: the maintainer ratified the complete revised R1–R6 bundle without amendments.
- After ratification, should Checkpoint A and Checkpoint B be separate Mission Control Deliveries or
  one feature branch with two review gates? Recommendation: separate bounded Deliveries, one
  integration branch/spec.
- Native Hermes support needs its own proof task after phase 1. The exact profile/home mechanism is
  intentionally not guessed in this SDD.
