# 377 — agent-soul-identity — tasks

_Generated from `plan.md` on 2026-07-13. Do not start implementation until the ratification gate is
checked._

## Ratification

- [ ] **T0. Lock R1–R6 with the maintainer.** Record accepted/changed choices and date in
      `spec.md`; update this task list if scope changes before delegating code.

## Checkpoint A — core and lifecycle

- [ ] **T1. Pin legacy behavior before refactoring.** Add exact no-soul prompt/command snapshots for
      role-only, instructions-only, role+instructions, Bridge guidance, ad-hoc contract, bound
      Delivery task, pipeline task, no-soul re-anchor, short body, and long-body pointer cases.
      Capture them before any production change from immutable BASE_SHA
      `23130cea1c1cf8046c1b09ac306de80d92c1bb0e`; pin it in a manifest and every fixture, fail tests on
      any SHA mismatch, and make the one-time capture helper refuse unless all imported legacy
      production seams are unchanged from that commit. Never regenerate expected bytes from the new
      renderer. Add BASE_SHA exact command/send-key fixtures for resume, host rebind, and native fork
      plus spies proving they call no prompt serializer/resolver/brief compositor. Keep new
      soul-enabled characterization fixtures in a separate non-parity suite. Explicitly pin today's
      role → instructions+task → Bridge serialization.
- [ ] **T2. Add config/schema support.** Add optional agent-only `soul: <relative-path>` to
      `ManagedEntryDef`, parser keys/validation, terminal rejection/sanitization,
      `tachyon.schema.json`, and YAML round-trip tests. Do not read the file during global config
      parsing.
- [ ] **T3. Implement the strict soul resolver.** Create `src/agents/soul.ts` with coordinator-root
      containment, forward-slash config paths, POSIX no-follow descriptor read/hash, documented
      Windows lstat/fstat residual race, fatal UTF-8, no normalization, NUL/empty rejection,
      Unicode-scalar/byte caps, exact-byte SHA-256 metadata, stable errors with an explicit
      total deterministic/transient `retryable` classification, same-handle double-read source
      change detection only after stable-size/sentinel oversize rejection, unknown-error fail-closed
      default, and adversarial/CRLF filesystem tests. Prove a stable file above 64 KiB schedules no
      retry.
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
      an honest channel-specific `offered` snapshot after launch handoff.
- [ ] **T8. Integrate resume/rebind/fork.** Pin exact BASE_SHA runtime command and send-key output for
      each path; prove none calls any legacy/soul prompt serializer, soul resolver, or long-brief
      compositor; prove resume/rebind never reload/inject soul, native fork never duplicates it, and
      fork metadata keeps the source reference/digest for later restart/re-anchor.
- [ ] **T9. Integrate declared executions.** Preserve `soul` in
      `deliveryDefinitionSnapshot`; cover bound Delivery, pipeline, schedule, declared subagent,
      parent ad-hoc non-inheritance, isolated worktree coordinator-root resolution, and rename
      reference preservation.
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
- [ ] **T12. Harden derived files.** Use atomic/private writes for soul-bearing spawn briefs and
      anchors; test lossless max-size transport and actionable write failure while retaining the
      current safe inline fallback rules. Pin `.tachyon` gitignore coverage, per-agent overwrite,
      stop/resume retention, and permanent dismiss/delete cleanup with no orphaned body.
- [ ] **T13. Run core adversarial review.** Use a different model family to review path security,
      lifecycle duplication, task-loss risk, ledger leakage, runtime honesty, and legacy
      compatibility. Fix every blocker/major and record accepted minors in `notes.md`.

## Checkpoint B — Agent Studio and product closure

- [ ] **T14. Add the Studio form field.** Round-trip `soul` through `FormState`, defaults, dirty
      restore, `fromDef`/`toEntry`, host validation, and error codes. Relabel the existing textarea
      “Persistent instructions”.
- [ ] **T15. Add typed host file actions.** Implement select/create/open/refresh/preview domain
      messages with workspace containment and bounded previews. Creation defaults to
      `.tachyon/souls/<agent>/SOUL.md`, revalidates the native save-dialog result, creates
      exclusively without silent overwrite, and never deletes/moves on clear/cancel/rename.
- [ ] **T16. Build the accessible Identity UI.** Place Identity before Role/Instructions, show
      lifecycle/runtime/not-for-secrets status, provide keyboard-operable file actions,
      `aria-live` feedback, labeled preview, narrow-width wrapping, and non-color-only states.
- [ ] **T17. Cover Studio behavior.** Add form, adapter, panel, shell protocol, browser-surface, and
      extension integration tests for valid/missing/oversize/outside/unsupported/Hermes states,
      create/select/open/clear, dirty restore, long path, and rename warning.
- [ ] **T18. Update product/runtime docs.** Update `README.md`, `docs/funcionalidades.html`, and
      `docs/runtimes/parity.md` with identity-vs-role-vs-instructions, configuration, precedence,
      lifecycle, raw-byte/CRLF semantics, argv/retention exposure, offered-vs-consumed channel state,
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

- [ ] Config/schema/YAML tests prove `soul` round-trip, agent-only validation, and old-config
      compatibility.
- [ ] Soul resolver tests prove containment, regular-file/no-symlink, UTF-8/NUL/empty, two limits,
      exact-byte/CRLF digest, Unicode-scalar counting, documented platform behavior, and actionable
      errors.
- [ ] Prompt tests prove exact soul-enabled order and `BASE_SHA`-provenanced golden byte-identical
      no-soul rendering across spawn/restart/re-anchor/Delivery/pipeline/short/long paths, with
      manifest/per-fixture SHA enforcement, exact resume/rebind/fork command/send-key parity, and
      negative all-compositor assertions for those bypass paths.
- [ ] Lifecycle tests prove fresh/restart refresh; resume/rebind/fork no-duplicate; re-anchor refresh;
      degraded recovery; deterministic and unknown-error immediate latch; concrete source-change
      detection only for within-cap reads; zero-retry stable oversize; transient-only 2s/4s/8s
      exhaustion including live-process-preserving human restart; and bound/pipeline/schedule/
      worktree/rename semantics.
- [ ] Persistence/privacy tests prove reference/digest/channel/offer/health-only ledger state,
      pointer-safe generated-file cleanup, and documented transcript/argv/provider exposure.
- [ ] Runtime tests prove prompt-capable delivery and fail-closed native-external/unsupported
      behavior, including recognized launchers, rejected wrappers, OpenCode prefill, and Hermes.
- [ ] Agent Studio unit/browser/integration tests prove file actions, validation, accessibility
      structure, and clear conceptual hierarchy.
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

**Human dogfood:** Create two same-role Claude/Codex agents with distinct files in Agent Studio;
compare the same neutral prompt, edit one source, verify resume does not refresh and restart/re-anchor
does, then rename and confirm the file was not moved. Provider use requires maintainer approval.

## Visual QA

- [ ] Evidence: wide and narrow Agent Studio captures for valid soul, missing file, unsupported
      runtime, Hermes externally managed, and long path.
- [ ] Verdict: Identity reads as “who”, Role/Instructions as “work”; file actions/status remain
      usable and advanced sections keep natural flow.
