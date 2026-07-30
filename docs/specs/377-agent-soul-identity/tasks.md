# 377 — agent-soul-identity — tasks

_Generated from `plan.md` on 2026-07-13. Ratified on 2026-07-14 and reconciled against the bounded
MVP shipped on `main` at `7761e46d` on 2026-07-15. Checked items below mean delivered with cited
evidence; deferred bullets are not delivery claims._

## Ratification

- [x] **T0. Lock R1–R6 with the maintainer.** On 2026-07-14 the maintainer accepted the complete
      revised bundle without amendments, including canonical `.tachyon/agents/<agent>` storage,
      import-as-copy, and the R2–R4/R6 recommendations. The lock date is recorded in `spec.md`.

## Checkpoint A — core and lifecycle

- [x] **T1. Pin legacy behavior before refactoring.** Add exact no-soul prompt/command snapshots for
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
- [x] **T2. Add config/schema support.** Add optional agent-only boolean `soul` to
      `ManagedEntryDef`: `true` enables, while `false`/absence disable. Reject non-booleans through
      the existing whole-config rejection/last-known-good contract and reject all terminal usage;
      derive `.tachyon/agents/<agent>/SOUL.md` through shared validated helpers, update
      `tachyon.schema.json`/YAML round-trip tests, and add `.tachyon/agents/` plus
      `.tachyon/agent-profile-transactions/` to Tachyon Init's machine-local ignore set. Do not read
      the file during global config parsing; file presence alone never enables identity. Reject
      ASCII-case-insensitive collisions among soul-enabled agent names without affecting no-soul
      legacy names.
- [x] **T3. Implement the strict soul profile store/resolver.** Create `src/agents/soul.ts` with
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
- [x] **T4. Add one runtime delivery capability.** Base it on `resolveBinary`, make
      `instructionsDeliverable` reuse it, classify prompt/native-external/unsupported runtimes, and
      test direct/`env`/package launchers, rejected shell wrappers/renamed binaries,
      OpenCode `tui-prefill/offered` state, and Hermes fail-closed diagnostics.
- [x] **T5. Implement typed prompt layers.** Create `src/agents/promptLayers.ts` with the soul →
      role → persistent instructions → Bridge guidance → task order, identity precedence copy, and
      the explicit legacy serializer that joins instructions+task before Bridge. Make all T1 golden
      snapshots stay byte-identical when `soul` is absent.
- [x] **T6. Separate the execution task.** Replace internal `appendInstructions` with `taskBrief`
      across `AgentManager`, Bridge/bound Delivery plumbing, pipeline/schedule call sites, helpers,
      and typed persistence; preserve the public Bridge request shape.
- [x] **T7. Integrate fresh spawn/restart.** Preflight source/capability at the outer boundary before
      worktree/stub/Delivery lease/token/harness/pane side effects, fail closed on unsupported/
      missing/invalid sources, preserve a live process on restart failure, compose through the
      shared layer model, latch deterministic unattended failures immediately, retry only enumerated
      transient failures at 2s/4s/8s before latching, never fall back identity-less, retain long-brief
      transport, preserve the current process through deterministic or transient-exhausted human
      restart, ensure stable oversize input takes the zero-retry deterministic path, and record only
      an honest channel-specific `offered` snapshot after launch handoff. Serialize profile preflight
      with mutations and persist/rollback a short-lived profile ID/digest launch reservation before
      releasing the shared lock.
- [x] **T8. Integrate resume/rebind/fork.** Pin exact BASE_SHA runtime command and send-key output for
      each path; prove none calls any legacy/soul prompt serializer, soul resolver, or long-brief
      compositor; prove resume/rebind never reload/inject soul, native fork never duplicates it, and
      fork metadata keeps enablement/canonical profile identity/digest for later restart/re-anchor.
- [x] **T9. Integrate declared executions.** Preserve `soul` in
      `deliveryDefinitionSnapshot`; cover bound Delivery, pipeline, schedule, declared subagent,
      parent ad-hoc non-inheritance, and isolated worktree coordinator-root resolution.
- **Deferred from T9:** rename transaction/collision/rollback. Clear/delete retention, explicit
  adoption on later name reuse, and permanent deletion were delivered through T15A/T16-MVP.
- [x] **T10. Extend the ledger defensively.** Add typed optional role/soul/task and metadata-only
      identity offer/health fields; migrate by absence, drop malformed snapshots safely, support
      `identity-degraded` without body/error-text leakage, and assert a distinctive soul body never
      appears in serialized ledger JSON.
- [x] **T11. Add soul-aware re-anchor.** Resolve and compose a complete private/atomic
      `.tachyon/anchors/<agent>.md` before injection, send a shell-quoted absolute pointer that works
      from worktrees/paths with spaces, update offered metadata only after success, show A→B digest
      transitions, persist degraded state/latch attention/pause auto retry on compaction failure
      until human retry without disrupting the session or adding a background watcher, and retain
      exact no-soul `.tachyon/roles` behavior.
- [x] **T12. Harden managed and derived files.** Use atomic/private writes for canonical imports,
      soul-bearing spawn briefs and
      anchors; test lossless max-size transport and actionable write failure while retaining the
      current safe inline fallback rules. Pin `.tachyon/agents` gitignore coverage, profile retention
      on clear/roster deletion, confirmed/collision-safe rename/delete, per-agent derived overwrite,
      stop/resume retention, and generated-copy cleanup with no orphaned body.
- [x] **T13. Run core adversarial review.** Use a different model family to review path security,
      lifecycle duplication, task-loss risk, ledger leakage, runtime honesty, and legacy
      compatibility. Fix every blocker/major and record accepted minors in `notes.md`.

## Checkpoint B — Agent Studio and product closure

- [x] **T14. Add Studio soul enablement.** Round-trip boolean soul enablement through `FormState`,
      defaults, dirty restore, `fromDef`/`toEntry`, host validation, and error codes: accept explicit
      `false` as disabled and emit `true` or omission from the two-state control. Relabel the existing
      textarea “Persistent instructions”.
- [x] **T15-MVP. Add typed canonical profile actions.** The shipped common path covers
      create/import-as-copy/open/automatic preview/adopt-or-enable/disable/confirmed replace and
      confirmed permanent deletion. Mutations use the Soul-owned durable journal, profile/digest CAS,
      admission lock and recovery/degraded state; the import source path is neither sent nor persisted.
- **Deferred from full T15:** agent rename, operator Complete/Roll Back Repair UI, exhaustive
  phase-by-phase crash injection, and the stronger adversarial external-writer/no-replace publication
  proof. These are not claimed by the MVP.
- [x] **T16-MVP. Build the accessible Identity UI.** Identity appears before Role/Persistent
      instructions with lifecycle/runtime status, automatic bounded preview, keyboard-operable common
      actions, explicit replace/delete confirmation, responsive wrapping, and non-color-only feedback.
- [x] **T17-MVP. Cover shipped Studio behavior.** Form, adapter, panel, shell protocol, engine and
      workspace tests cover the delivered common actions, validation, source-path non-persistence,
      stable profile IDs, retained-profile adoption, stale replacement digests, rollback, collision,
      and launch-reservation admission.
- **Deferred from full T17:** rename/repair UI, exhaustive crash-at-every-phase coverage, and the full
  combinatorial browser matrix for every invalid state.
- [x] **T18. Update product/runtime docs.** Update `README.md`, `docs/funcionalidades.html`, and
      `docs/runtimes/parity.md` with identity-vs-role-vs-instructions, configuration, precedence,
      canonical profile/import-copy semantics, lifecycle, raw-byte/CRLF semantics, argv/retention
      exposure, future-persistence boundary, offered-vs-consumed channel state,
      prompt/prefill/native/unsupported matrix, wrapper limits, and the Hermes follow-up boundary.
- **Deferred T19:** Add deterministic `npm run dogfood -- agent-soul` coverage with two
      same-role agents, distinct souls, real composition/shell delivery, no paid inference,
      metadata-only ledger assertions, and resume-vs-restart/re-anchor refresh proof.
- [x] **T20-MVP. Run human dogfood and Visual QA.** Human dogfood confirmed distinct Soul delivery
      through Claude, Codex, Grok, and OpenCode plus create/import/replace/enable/disable/edit/delete.
      The T14 visual review accepted the Identity ordering and dense 900x900 state. No subjective
      personality claim is used as a gate.
- [x] **T21. Closure audit.** Re-run full verification, audit the acceptance/non-goals, update runtime
      parity with dated proof, and mark the spec `shipped-partial`. Native Hermes support remains an
      explicit independent candidate, not a hidden part of this closure.

## Verification

- [x] Config/schema/YAML tests cover boolean semantics, canonical path derivation, agent-only
      validation, case-fold collisions, init ignore coverage, LKG behavior, and legacy compatibility.
- [x] Profile/resolver tests cover import-as-copy, private atomic writes, containment, file/encoding/
      size validation, exact-byte digests, stable profile ownership, adoption, and actionable errors.
- [x] Prompt/lifecycle tests cover typed ordering, byte-identical no-soul fixtures, spawn/restart/
      re-anchor refresh, resume/rebind/fork non-duplication, declared executions, bounded retry,
      reservations, degraded state, and long-brief transport for the shipped scope.
- [x] Persistence/privacy/runtime tests cover metadata-only ledger state, import-path disposal,
      generated-copy cleanup, prompt-capable channels, recognized launchers, OpenCode prefill, and
      fail-closed Hermes/unsupported handling.
- [x] Agent Studio/domain/engine/workspace/browser tests cover the shipped create/import/adopt/
      replace/open/disable/delete common path, digest CAS, validation, rollback, and accessible
      conceptual hierarchy.
- **Deferred verification:** deterministic headless Soul dogfood, rename/repair, and the exhaustive
  crash/browser permutations attached to those unshipped surfaces.
- [x] Full repository gate is green on the delivered SHA and is re-run for this closure.

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** This documentation-only closure adds no behavior to exercise. The shipped MVP
already has maintainer-confirmed real dogfood for distinct canonical identities on Claude, Codex,
Grok, and OpenCode, including create, import/confirmed replace, enable/disable, edit, and delete.
Deterministic headless dogfood remains explicitly deferred instead of being fabricated here.

## Visual QA

Evidence: the T14 review accepted new/off and dense-edit/on Agent Studio fixtures at 900×900; the
subsequent Dev Host session exercised the functional Identity panel and confirmed replacement flow.

Verdict: the shipped common path keeps Identity as “who” ahead of Role/Persistent instructions as
“work”, with usable file actions and explicit destructive confirmations. The unshipped exhaustive
state gallery is not claimed.

**Cookbook-Opt-Out:** Soul is configured and managed through existing Agent Studio and
`tachyon.yml` surfaces documented in the product guide; it introduces no standalone operator tool.
