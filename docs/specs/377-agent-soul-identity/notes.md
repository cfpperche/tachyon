# 377 — agent-soul-identity — notes

_Created 2026-07-13. Append-only after this planning checkpoint._

## Design decisions

### 2026-07-13 — draft recommendations, pending ratification

- Identity must remain distinct from `role`. Spec 216 explicitly defined role templates as reusable
  task contracts and excluded persona prompting; this feature adds the missing layer rather than
  changing that meaning.
- Use one explicit per-agent `soul` file reference. A shared soul is expressed by two agents pointing
  to the same path, not by hidden inheritance.
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
- The existing domain action is a cwd folder picker. Soul needs separate file select/create/open/
  preview actions, not an overloaded browse reply.
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
- Prompt composition gives consistent Tachyon semantics but not native system-prompt priority.
  Product copy must stay honest about that distinction.
- A metadata digest helps audit which version a transcript received, but v1 deliberately avoids
  background watching and “stale soul” badges unless they can be added without a new file watcher.
- Keeping exact no-soul rendering requires a compatibility branch in the compositor. Removing it
  would simplify code but silently rewrite every existing agent's opening prompt.

## Review log

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

## Open questions

- Does the maintainer accept `R1`–`R6` as one recommended bundle, or want any exception?
- After ratification, should Checkpoint A and Checkpoint B be separate Mission Control Deliveries or
  one feature branch with two review gates? Recommendation: separate bounded Deliveries, one
  integration branch/spec.
- Native Hermes support needs its own proof task after phase 1. The exact profile/home mechanism is
  intentionally not guessed in this SDD.
