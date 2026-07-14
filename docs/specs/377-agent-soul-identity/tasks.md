# 377 — agent-soul-identity — tasks

_Generated from `plan.md` on 2026-07-13. The ratification gate was locked on 2026-07-14;
implementation still requires separately assigned bounded Deliveries._

## Ratification

- [x] **T0. Lock R1–R6 with the maintainer.** On 2026-07-14 the maintainer accepted the complete
      revised bundle without amendments, including canonical `.tachyon/agents/<agent>` storage,
      import-as-copy, and the R2–R4/R6 recommendations. The lock date is recorded in `spec.md`.

## Checkpoint A — core and lifecycle

- [ ] **T1. Pin legacy behavior before refactoring.** Add exact no-soul prompt/command snapshots for
      role-only, instructions-only, role+instructions, Bridge guidance, ad-hoc contract, bound
      Delivery task, pipeline task, no-soul re-anchor, short body, and long-body pointer cases.
      Capture them before any production change from immutable BASE_SHA
      `6885becd72dbd1a4eed270a3233f5d8e0a3e310e`; pin it in a manifest and every fixture, fail tests on
      any SHA mismatch, and make the one-time capture helper refuse unless all imported legacy
      production seams are unchanged from that commit. Never regenerate expected bytes from the new
      renderer. Add BASE_SHA exact command/send-key fixtures for resume, host rebind, and native fork
      plus spies proving they call no prompt serializer/resolver/brief compositor. Keep new
      soul-enabled characterization fixtures in a separate non-parity suite. Explicitly pin today's
      role → instructions+task → Bridge serialization.
- [ ] **T2. Add config/schema support.** Add optional agent-only boolean `soul` to
      `ManagedEntryDef`: `true` enables, while `false`/absence disable. Reject non-booleans through
      the existing whole-config rejection/last-known-good contract and reject all terminal usage;
      derive `.tachyon/agents/<agent>/SOUL.md` through shared validated helpers, update
      `tachyon.schema.json`/YAML round-trip tests, and add `.tachyon/agents/` plus
      `.tachyon/agent-profile-transactions/` to Tachyon Init's machine-local ignore set. Do not read
      the file during global config parsing; file presence alone never enables identity. Reject
      ASCII-case-insensitive collisions among soul-enabled agent names without affecting no-soul
      legacy names.
- [ ] **T3. Implement the strict soul profile store/resolver.** Create `src/agents/soul.ts` with
      canonical profile derivation, a Tachyon-owned `profile.json` carrying schema version, random
      stable `profileId`, owner name, and `active|retained` state, validated agent names,
      coordinator-root containment, POSIX
      no-follow descriptor read/hash, documented
      Windows lstat/fstat residual race, fatal UTF-8, no normalization, NUL/empty rejection,
      Unicode-scalar/byte caps, exact-byte SHA-256 metadata, stable errors with an explicit
      total deterministic/transient `retryable` classification, same-handle double-read source
      change detection only after stable-size/sentinel oversize rejection, unknown-error fail-closed
      default, and adversarial/CRLF filesystem tests. Add exact-byte import staging for a private
      canonical copy, discard the original path, require an active same-owner manifest at runtime,
      return `profile-adoption-required` for retained/missing/unknown ownership, and prove stable
      oversize schedules no retry.
- [ ] **T4. Add one runtime delivery capability.** Base it on `resolveBinary`, make
      `instructionsDeliverable` reuse it, classify prompt/native-external/unsupported runtimes, and
      test direct/`env`/package launchers, rejected shell wrappers/renamed binaries,
      OpenCode `tui-prefill/offered` state, and Hermes fail-closed diagnostics.
- [ ] **T5. Implement typed prompt layers.** Create `src/agents/promptLayers.ts` with the soul →
      role → persistent instructions → Bridge guidance → task order, identity precedence copy, and
      the explicit legacy serializer that joins instructions+task before Bridge. Make all T1 golden
      snapshots stay byte-identical when `soul` is absent.
- [ ] **T6. Separate the execution task.** Replace internal `appendInstructions` with `taskBrief`
      across `AgentManager`, Bridge/bound Delivery plumbing, pipeline/schedule call sites, helpers,
      and typed persistence; preserve the public Bridge request shape.
- [ ] **T7. Integrate fresh spawn/restart.** Preflight source/capability at the outer boundary before
      worktree/stub/Delivery lease/token/harness/pane side effects, fail closed on unsupported/
      missing/invalid sources, preserve a live process on restart failure, compose through the
      shared layer model, latch deterministic unattended failures immediately, retry only enumerated
      transient failures at 2s/4s/8s before latching, never fall back identity-less, retain long-brief
      transport, preserve the current process through deterministic or transient-exhausted human
      restart, ensure stable oversize input takes the zero-retry deterministic path, and record only
      an honest channel-specific `offered` snapshot after launch handoff. Serialize profile preflight
      with mutations and persist/rollback a short-lived profile ID/digest launch reservation before
      releasing the shared lock.
- [ ] **T8. Integrate resume/rebind/fork.** Pin exact BASE_SHA runtime command and send-key output for
      each path; prove none calls any legacy/soul prompt serializer, soul resolver, or long-brief
      compositor; prove resume/rebind never reload/inject soul, native fork never duplicates it, and
      fork metadata keeps enablement/canonical profile identity/digest for later restart/re-anchor.
- [ ] **T9. Integrate declared executions.** Preserve `soul` in
      `deliveryDefinitionSnapshot`; cover bound Delivery, pipeline, schedule, declared subagent,
      parent ad-hoc non-inheritance, isolated worktree coordinator-root resolution, and rename
      transaction/collision/rollback plus clear/delete profile retention and explicit adoption on
      later name reuse.
- [ ] **T10. Extend the ledger defensively.** Add typed optional role/soul/task and metadata-only
      identity offer/health fields; migrate by absence, drop malformed snapshots safely, support
      `identity-degraded` without body/error-text leakage, and assert a distinctive soul body never
      appears in serialized ledger JSON.
- [ ] **T11. Add soul-aware re-anchor.** Resolve and compose a complete private/atomic
      `.tachyon/anchors/<agent>.md` before injection, send a shell-quoted absolute pointer that works
      from worktrees/paths with spaces, update offered metadata only after success, show A→B digest
      transitions, persist degraded state/latch attention/pause auto retry on compaction failure
      until human retry without disrupting the session or adding a background watcher, and retain
      exact no-soul `.tachyon/roles` behavior.
- [ ] **T12. Harden managed and derived files.** Use atomic/private writes for canonical imports,
      soul-bearing spawn briefs and
      anchors; test lossless max-size transport and actionable write failure while retaining the
      current safe inline fallback rules. Pin `.tachyon/agents` gitignore coverage, profile retention
      on clear/roster deletion, confirmed/collision-safe rename/delete, per-agent derived overwrite,
      stop/resume retention, and generated-copy cleanup with no orphaned body.
- [ ] **T13. Run core adversarial review.** Use a different model family to review path security,
      lifecycle duplication, task-loss risk, ledger leakage, runtime honesty, and legacy
      compatibility. Fix every blocker/major and record accepted minors in `notes.md`.

## Checkpoint B — Agent Studio and product closure

- [ ] **T14. Add Studio soul enablement.** Round-trip boolean soul enablement through `FormState`,
      defaults, dirty restore, `fromDef`/`toEntry`, host validation, and error codes: accept explicit
      `false` as disabled and emit `true` or omission from the two-state control. Relabel the existing
      textarea “Persistent instructions”.
- [ ] **T15. Add typed canonical profile actions.** Implement import/create/open/refresh/preview/
      adopt/enable/disable/delete/rename/repair domain messages. Import explicitly reads a selected
      local regular file, validates
      and stages exact bytes for `.tachyon/agents/<agent>/SOUL.md`, never persists the source path,
      treats self-selection as Adopt/Enable, and requires digest-backed replace confirmation. Create
      a stable random `profileId`; Clear/roster deletion mark its manifest retained and retain data.
      Every import/create/replace/adopt/enable/disable/rename/delete mutation is serialized through a
      durable `.tachyon/agent-profile-transactions/` journal with same-filesystem staging/backup,
      affected-stanza/name-presence compare-and-swap, profile ID/digests, compensation/startup
      recovery, and blocking `profile-transaction-degraded` state; unrelated `tachyon.yml` edits do
      not invalidate recovery. Add a confirmed Repair action that can Complete or Roll Back a
      provably reconcilable journal; never reuse
      plugin-owned `.tachyon/transactions/`. Profile deletion remains a separate,
      destructive, confirmed action allowed only with soul disabled and no live session; any resumable
      row must first be permanently dismissed/purged, optionally through a second-confirmed combined
      action. Recheck those preconditions under the shared lock. Case-only rename must record its
      unique temporary sibling before journaling `old → temporary sibling → new`, treat the same
      folded-name/profile ID as self-rename, reject any distinct active/retained folded manifest on
      create/import/adopt/rename, and recover every phase. Durably flush staged bytes,
      quarantine/verify a confirmed Replace destination with separate rollback bytes, publish through
      an atomic no-replace primitive, flush the directory where supported, then reopen through the
      strict resolver and verify the expected digest before committing config/manifest state.
- [ ] **T16. Build the accessible Identity UI.** Place Identity before Role/Instructions, show
      lifecycle/runtime/not-for-secrets status, provide keyboard-operable file actions,
      `aria-live` feedback, labeled preview, narrow-width wrapping, and non-color-only states.
- [ ] **T17. Cover Studio behavior.** Add form, adapter, panel, shell protocol, browser-surface, and
      extension integration tests for valid/missing/oversize/import-symlink/unsupported/Hermes states,
      create/import/adopt/replace/open/clear/delete, dirty restore, source-path non-persistence, and
      every profile-mutation success/collision/rollback plus crash injection at every journal phase.
      Prove retained-profile/name-reuse adoption, stable profile IDs, affected-stanza recovery despite
      unrelated config edits, active/retained folded-name collision refusal, operator Complete/Roll
      Back repair, and bounded resume purge before deletion. Race every mutation and Replace digest
      confirmation against spawn/restart/re-anchor
      admission; assert stale digests and launch reservations block conflicting writes.
- [ ] **T18. Update product/runtime docs.** Update `README.md`, `docs/funcionalidades.html`, and
      `docs/runtimes/parity.md` with identity-vs-role-vs-instructions, configuration, precedence,
      canonical profile/import-copy semantics, lifecycle, raw-byte/CRLF semantics, argv/retention
      exposure, future-persistence boundary, offered-vs-consumed channel state,
      prompt/prefill/native/unsupported matrix, wrapper limits, and the Hermes follow-up boundary.
- [ ] **T19. Add deterministic headless dogfood.** Add `npm run dogfood:agent-soul` with two
      same-role agents, distinct souls, real composition/shell delivery, no paid inference,
      metadata-only ledger assertions, and resume-vs-restart/re-anchor refresh proof.
- [ ] **T20. Run human dogfood and Visual QA.** Exercise two real agents only with maintainer-approved
      provider use; inspect wide/narrow Agent Studio states with the `visual-qa` skill and attach
      screenshots/verdict. Treat personality differences as advisory; offer/composition evidence is
      the gate.
- [ ] **T21. Closure audit.** Re-run full verification, audit every acceptance criterion/non-goal,
      update runtime parity with concrete dated proof, close or create the separately scoped Hermes
      native adapter task, and mark the spec shipped only with dogfood evidence.

## Verification

- [ ] Config/schema/YAML tests prove boolean `soul` semantics (`true`, `false`, absence, and rejected
      non-booleans), canonical path derivation, agent-only validation, inert leftover files, init
      gitignore coverage, existing whole-config/LKG behavior, and old-config compatibility.
- [ ] Soul profile/resolver tests prove import-as-copy and source-path disposal, atomic private writes,
      containment, regular-file/no-symlink, UTF-8/NUL/empty, two limits, exact-byte/CRLF digest,
      Unicode-scalar counting, manifest/profile-ID ownership and adoption-required states, durable
      flush/reopen/digest verification, documented platform behavior, and actionable errors.
- [ ] Prompt tests prove exact soul-enabled order and `BASE_SHA`-provenanced golden byte-identical
      no-soul rendering across spawn/restart/re-anchor/Delivery/pipeline/short/long paths, with
      manifest/per-fixture SHA enforcement, exact resume/rebind/fork command/send-key parity, and
      negative all-compositor assertions for those bypass paths.
- [ ] Lifecycle tests prove fresh/restart refresh; resume/rebind/fork no-duplicate; re-anchor refresh;
      degraded recovery; deterministic and unknown-error immediate latch; concrete source-change
      detection only for within-cap reads; zero-retry stable oversize; transient-only 2s/4s/8s
      exhaustion including live-process-preserving human restart; and bound/pipeline/schedule/
      worktree/canonical rename/retention semantics, including journaled crash recovery and blocking
      degraded transactions, affected-stanza recovery across unrelated config edits, case-only
      rename recovery, and operator Complete/Roll Back repair.
- [ ] Persistence/privacy tests prove enablement/canonical-profile/digest/channel/offer/health-only
      ledger state, no original import path, clear/delete retention, pointer-safe explicit profile
      deletion/generated-file cleanup, and documented transcript/argv/provider exposure.
- [ ] Runtime tests prove prompt-capable delivery and fail-closed native-external/unsupported
      behavior, including recognized launchers, rejected wrappers, OpenCode prefill, and Hermes.
- [ ] Agent Studio unit/browser/integration tests prove canonical create/import/adopt/replace/open/
      clear/rename/delete/repair actions, digest compare-and-swap, bounded resume purge, validation,
      accessibility, and clear conceptual hierarchy.
- [ ] Headless dogfood proves two same-role agents receive only their distinct souls without provider
      inference.
- [ ] Full repository gate is green and the worktree is clean.

**Verify:** `npm run typecheck`

**Verify:** `npx vitest run test/unit/soul.test.ts test/unit/promptLayers.test.ts test/unit/config.test.ts test/unit/agentManager.test.ts test/unit/resume.test.ts test/unit/agentStudio.test.ts test/unit/agentStudioAdapter.test.ts test/unit/agentStudioPanel.test.ts test/unit/webviewShellParity.test.ts`

**Verify:** `npm run test:browser`

**Verify:** `npm run verify:full:quiet`

**Headless check:** `npm run dogfood:agent-soul`

## Dogfood

**Dogfood:** `npm run dogfood:agent-soul`

**Human dogfood:** Create two same-role Claude/Codex agents, import distinct files, and verify only
their canonical `.tachyon/agents/<agent>/SOUL.md` copies are used. Compare the same neutral prompt,
edit one canonical copy, verify resume does not refresh and restart/re-anchor does, then rename and
confirm the profile moved transactionally. Provider use requires maintainer approval.

## Visual QA

- [ ] Evidence: wide and narrow Agent Studio captures for valid soul, import/replace confirmation,
      retained profile, missing file, unsupported runtime, and Hermes externally managed.
- [ ] Verdict: Identity reads as “who”, Role/Instructions as “work”; file actions/status remain
      usable and advanced sections keep natural flow.
