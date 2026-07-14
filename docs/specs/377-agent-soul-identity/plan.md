# 377 — agent-soul-identity — plan

_Drafted from `spec.md` on 2026-07-13._

This is an implementation plan, not implementation authorization. Production work starts only after
the maintainer ratifies `R1`–`R6` in the spec.

## Current-state inventory

| Seam | Current behavior | Design consequence |
|---|---|---|
| `src/config/loadConfig.ts` | `ManagedEntryDef` has `role` and `instructions`, but no identity source; `INSTRUCTION_ARG` supports Claude, Codex, Agy, Gemini, OpenCode, and Grok | Add an agent-only `soul` reference and expose one authoritative opening-prompt capability predicate |
| `src/config/tachyon.schema.json` | Describes `instructions` as a role prompt and `role` as an operational template | Add `soul` schema/docs and correct the identity/role/instructions vocabulary |
| `src/config/YamlConfigEditor.ts` | Full agent upsert preserves known fields; terminal sanitization removes `kind`/`instructions` | Round-trip `soul` and strip/reject it for terminals |
| `src/roles/templates.ts` | Explicitly defines roles as task contracts, composes template → instructions, adds Bridge guidance, and builds `.tachyon/roles/<agent>.md` | Preserve role semantics; move multi-layer composition and identity anchoring to a dedicated module |
| `AgentManager.effectiveCmd` | Flattens role + instructions + Bridge guidance, diverts long bodies to a brief file, wraps primer, and calls `composeCommand` | Replace the implicit string pipeline with typed layers while retaining the exact legacy render when no soul exists |
| `AgentManager.spawnCore` | Pipeline/Delivery text is appended into `def.instructions` via `appendInstructions` | Introduce an internal `taskBrief` slot; stop mutating persistent instructions |
| `src/bridge/spawnContract.ts` / `src/bridge/tools.ts` | Structured ad-hoc contract is rendered to one brief string; bound declared executions pass it as `appendInstructions` | Keep the external Bridge API stable but hand the rendered contract to the task layer |
| `Workspace` pipeline spawn | Appends the node objective through `appendInstructions` | Route it through `taskBrief` |
| `src/bridge/primer.ts` | Primer is prepended; before-finishing is appended; precedence says task wins task-specifics and primer wins protocol | Keep both envelope positions and make soul explicitly subordinate to protocol/authority |
| `src/agents/briefFile.ts` | Body over 4,000 chars is written losslessly to `.tachyon/briefs/spawn/<agent>.md` and replaced by a pointer | Compose all body layers before this boundary; harden derived-file permissions without changing short legacy delivery |
| `src/resume/adapters.ts` | Resume replays the same transcript and intentionally never redelivers instructions | Soul follows the same no-duplicate resume rule |
| `src/resume/SessionLedger.ts` | Persists restart definition and resume metadata; no role/soul/task layer or identity-offer digest | Persist references/typed task data and an identity snapshot, never the body |
| `AgentManager.restart` | Reuses `effectiveCmd` and therefore recomposes persistent prompt input | Reload current soul |
| `AgentManager.resume` | Rebuilds runtime resume command; optionally re-injects only the compact primer | Do not resolve or inject soul |
| `AgentManager.commitFork` | Native transcript fork; no opening instructions are recomposed | Copy soul reference/digest metadata; use current source only on later restart/re-anchor |
| `deliveryDefinitionSnapshot` | Clones a declared definition for a bound ephemeral Delivery | Preserve `soul` while stripping lifecycle/worktree ownership fields |
| `Workspace.reanchor` | Writes role + instructions to `.tachyon/roles/<agent>.md` and sends a pointer plus primer | Soul-enabled agents get a full generated anchor from the same typed compositor; existing no-soul role anchoring stays compatible |
| `src/harness/HarnessManager.ts` | Materializes Claude `CLAUDE.md` rules and Codex `AGENTS.md` instructions in private homes | Do not overload harness files with soul in phase 1; they are runtime-native repo/instruction channels |
| Agent Studio | Shows “Role template” and “Instructions (role prompt)”; browser shell has only a cwd picker domain action | Add a separate Identity/SOUL section and host-backed select/create/open/preview actions |
| `docs/runtimes/parity.md` | Brief delivery is capability row 1; secondary runtime limitations are documented | Add an identity-delivery row/subsection with verified prompt/native/unsupported status |

## Approach

### 1. Add a narrow source type, not a persona subsystem

Extend the agent definition with:

```ts
interface ManagedEntryDef {
  soul?: string; // workspace-relative Markdown source
}
```

The value is a path only, stored with portable forward slashes. `loadConfig` performs structural
validation (non-empty string, relative, no backslashes/traversal/NUL, agent-only). Agent Studio
normalizes native picker results to that form; an already-valid configured string round-trips
unchanged. Source existence/content is validated at the lifecycle boundary, not during global
config parsing, so one temporarily missing local file does not force the whole workspace onto the
last-known-good config. A fresh start still fails closed for that specific agent.

No new top-level `souls:` registry, `settings.soul` default, profile inheritance, or inline object is
introduced. Reuse is explicit: multiple agents can point at the same file. Agent Studio's create
action suggests `.tachyon/souls/<agent>/SOUL.md`, a local/gitignored convention; users may choose a
versioned workspace path when sharing identity is intentional.

### 2. Resolve identity through one strict, testable boundary

Add `src/agents/soul.ts` with no UI or runtime dependencies:

```ts
interface ResolvedSoul {
  source: string;       // forward-slash workspace-relative display path
  body: string;         // exact decoded payload, never persisted in ledger
  sha256: string;
  chars: number;
  bytes: number;
}

interface SoulSnapshot {
  source: string;
  sha256: string;
  chars: number;
  bytes: number;
  channel: "startup-argument" | "tui-prefill" | "reanchor-pointer";
  state: "offered";
  offeredAt: string;
}
```

Resolution algorithm:

1. Reject empty, absolute, NUL-containing, or syntactically traversing input.
2. Resolve against `workspaceRoot`, not `cwd`/worktree.
3. Canonicalize the real workspace root and parent directory; require containment.
4. On POSIX, open with `O_NOFOLLOW`, `fstat` the descriptor, and require a regular file. On Windows,
   compare pre-open `lstat` with the opened file identity/`fstat` where Node exposes it. Document the
   residual same-user parent-replacement race instead of claiming a portable no-race guarantee
   outside the trusted workspace threat model.
5. Before change detection, return deterministic `soul/too-many-bytes` with no retry when the opened
   descriptor reports more than 64 KiB or either bounded read observes the 64 KiB + 1 sentinel byte.
   Otherwise, through that one handle perform two reads from explicit offset zero with descriptor
   stats before/between/after. Only for within-cap observations, differing payloads,
   bytes-vs-stable-size mismatch, or size/mtime/ctime changes return retryable
   `soul/source-changed-during-read`. An atomic rename leaves the opened descriptor valid; `ENOENT`
   from the initial open maps to deterministic `soul/missing`.
6. Bound both raw reads before decoding. Decode the one proven-stable payload once with a fatal UTF-8
   decoder, reject embedded NUL and whitespace-only text, count Unicode
   scalar values, and enforce both limits.
7. Compute SHA-256 from the exact stable raw bytes and insert the decoded payload without line-ending or
   whitespace normalization. CRLF/LF checkouts intentionally produce different payloads/digests.
   Count characters as Unicode scalar values.

Errors use stable codes `soul/path-invalid`, `soul/missing`, `soul/outside-workspace`,
`soul/final-symlink`, `soul/not-regular`, `soul/permission-denied`, `soul/invalid-utf8`,
`soul/empty`, `soul/too-many-chars`, `soul/too-many-bytes`, and
`soul/runtime-unsupported`, plus retryable `soul/source-changed-during-read`; UI and lifecycle
callers map codes to contextual messages instead of matching prose. The error type carries a total,
stable `retryable` classification: only underlying `EIO`, `EBUSY`, `EMFILE`, `ENFILE`, and
`soul/source-changed-during-read` are `true`. Every listed deterministic code and every unknown
error defaults to `false`/fail-closed. Callers never infer retry behavior from message text.

### 3. Introduce typed prompt layers with a legacy renderer

Add `src/agents/promptLayers.ts`:

```ts
interface AgentPromptLayers {
  soul?: ResolvedSoul;
  role?: Role;
  instructions?: string;
  bridgeGuidance: boolean;
  taskBrief?: string;
}

interface ComposedAgentBody {
  body?: string;
  soul?: SoulSnapshot;
}
```

For a soul-enabled agent, render labeled sections in this body order:

1. identity / soul;
2. role contract;
3. persistent instructions;
4. Bridge coordination guidance;
5. current task/delegation brief.

The identity section includes the relative source and the rule that it shapes voice/values but
cannot override authority, repository rules, Tachyon protocol, or the current task. It does not
include an absolute host path.

`wrapWithPrimer` remains outside that body, so the final order is primer → body layers →
before-finishing. `deliverableBody` still runs on the complete body before the primer wrapper, exactly
as today.

Compatibility is an explicit branch, not an assumption. When `soul` is absent, first serialize
`legacyInstructions = [instructions, taskBrief].filter(Boolean).join("\\n\\n")`, then call the current
`composeInstructions(role, legacyInstructions)` and only then `withBridgeGuidance`. This reproduces
today's exact role → instructions+task → Bridge order even though task is typed internally. Golden
snapshots pin byte equality for every legacy combination. Before any production refactor, T1 captures
them from exactly `23130cea1c1cf8046c1b09ac306de80d92c1bb0e` into
`test/fixtures/agent-soul/legacy-parity/`; its manifest and every fixture record that same SHA, and a
test fails on any mismatch. The one-time capture helper first refuses unless `git diff` proves every
legacy production seam it imports is unchanged from that SHA; it is not a routine snapshot-update
command. Expected bytes are never regenerated from the new renderer. These parity fixtures cover
no-soul fresh spawn, restart, re-anchor, bound Delivery/pipeline tasks, and the
already-existing short/long-brief transport. Separate soul-enabled characterization tests are
spec-derived and are not labeled BASE_SHA parity fixtures. Resume, host rebind, and native fork get
their own BASE_SHA command/send-key fixtures plus assertions that no prompt serializer, soul
resolver, or long-brief compositor is called. The soul-enabled renderer alone uses the new
task-after-Bridge order. `appendInstructions` may be removed only after those baseline fixtures
exist and their manifest guard is green.

### 4. Make task specificity typed through spawn and persistence

Rename internal `SpawnOptions.appendInstructions` to `taskBrief` and update:

- Bridge ad-hoc and bound-Delivery spawn plumbing;
- pipeline node spawn;
- schedule/declared execution sites that supply a one-run objective;
- restart/re-anchor reconstruction;
- test helpers.

The public Bridge `instructions` argument remains compatible: for an ad-hoc delegation it is still
additional contract prose, but the resulting rendered contract is placed in `taskBrief` rather than
mutating the declared agent's persistent `instructions`.

Extend `SessionDef` defensively with optional `role`, `soul`, and `taskBrief` so an ad-hoc bound
execution/fork can reconstruct its layers after host reload. Extend `SessionRecord` with:

```ts
identity?: {
  soul: SoulSnapshot;
  health: "offered" | "identity-degraded";
  degradedAt?: string;
  degradedCode?: string;
}
```

The parser drops malformed metadata without invalidating the whole ledger. No `body` field is
accepted. Existing rows migrate by absence.

Refactor `effectiveCmd` into an internal result that carries both the command and optional snapshot:

```ts
{ cmd: string; soul?: SoulSnapshot }
```

Record `state: "offered"` only after the runtime launch/prefill/pointer handoff is accepted. This
does not claim provider/model consumption. If the process dies between launch and ledger write,
metadata is absent/unknown rather than falsely “delivered”. Restart replaces the offer; resume/
rebind preserves it; fork copies it.

### 5. Enforce the lifecycle table at explicit call sites

#### Fresh spawn and restart

- Resolve only when `def.soul` is present.
- Consult runtime capability before launching.
- Compose once and carry the resulting digest to the ledger.
- Split identity preflight from final prompt composition so capability/source validation happens
  before agent-specific worktree/stub creation, Delivery lease acquisition, token/harness
  materialization, or pane creation/replacement. The bound-Delivery outer acquisition path must
  preflight the selected declared definition before `prepareDeliveryJoin`, not merely inside
  `spawnCore`.
- A failed restart leaves the current pane/process and its ledger identity untouched.
- Crash restart uses the same code path and therefore reloads the file. Deterministic soul source/
  capability errors latch immediately, stop the existing crash-backoff loop, and wait for repair
  followed by manual restart. Only explicitly retryable errors schedule attempts after 2s/4s/8s;
  unknown errors default to deterministic, and exhaustion latches. Never auto-remove the soul or
  start identity-less.
- Human fresh spawn/restart uses the same bounded transient schedule without blocking the extension
  host. The current process is not replaced before successful restart preflight; deterministic
  failure and transient exhaustion both preserve it and surface an actionable latched error.
- Autostart/schedule/pipeline/Delivery uses the same error taxonomy before agent-specific
  acquisition. A failed execution is durable/auditable; a later scheduled execution may preflight
  again, but the same execution never enters an unbounded or tight retry loop.

#### Resume and host rebind

- Do not call the soul resolver.
- Do not add the soul to the compact primer.
- Preserve `record.identity` while updating only resume/Bridge binding metadata.
- Agent Studio or the sidebar may show “session uses digest A; source now differs” later, but v1
  does not need background file watching.

#### Re-anchor

- For a soul-enabled agent, resolve current content and use the shared compositor to write
  `.tachyon/anchors/<agent>.md` containing identity, role, persistent instructions, Bridge guidance,
  and current task where available.
- Write atomically with private permissions, then inject a short pointer + full primer/
  before-finishing envelope.
- The injected `cat` pointer is a shell-quoted absolute coordinator-workspace path (the same
  accessibility principle as long spawn briefs), because a worktree agent's relative `.tachyon` is
  a different directory.
- Update offered identity metadata only after the file write and terminal injection succeed.
- A source failure returns through the Bridge/manual action and emits a visible workspace warning.
  When compaction prompted the attempt, persist `identity-degraded`, latch human attention, and
  suppress automatic retries until a human retries re-anchor/restart after source repair. Leave the
  session alive, add no background soul watcher, and do not send a partial role-only anchor.
- If the offered digest changes from A to B (including a fork later re-anchored to a newer source),
  emit a visible Activity/Studio transition rather than silently replacing live identity.
- For an agent without soul, keep `buildRoleDoc`, `.tachyon/roles/<agent>.md`, and the current
  reminder text unchanged.

#### Fork

- Native transcript fork remains the identity carrier; never render another soul block.
- Copy `SessionDef.soul` and `SessionRecord.identity` to the fork row.
- A later fork restart/re-anchor resolves the current source from the coordinator root.
- A parent soul is not inherited by an unrelated ad-hoc child.

#### Bound Delivery, pipeline, schedule, worktree, rename

- `deliveryDefinitionSnapshot` retains `soul` and `role`.
- Bound executions carry the declared principal's identity reference; their Delivery contract is
  `taskBrief`.
- Pipeline/schedule runs selected from a declared agent behave the same.
- All source resolution uses the coordinating root even when execution `cwd` is a Delivery/
  pipeline/worktree checkout.
- Rename changes only the agent key. Studio warns when the conventional path still contains the old
  name; moving the source is an explicit separate file operation.

### 6. Replace implicit runtime guessing with an identity capability

Create one exported capability lookup built on `resolveBinary`, and make
`instructionsDeliverable` use it too (fixing today's launcher mismatch where the warning predicate
looks only at token zero while `composeCommand` sees through `env`/`npx`).

Suggested shape:

```ts
type OpeningPromptCapability =
  | { status: "prompt"; runtime: string }
  | { status: "native-external"; runtime: "hermes"; detail: string }
  | { status: "unsupported"; runtime: string };
```

Phase 1:

- `prompt`: Claude, Codex, Agy, Gemini, OpenCode, Grok. Mark OpenCode specifically as
  `tui-prefill/offered`, not proof that the user submitted the prefill.
- `native-external`: Hermes, because the installed CLI loads `$HERMES_HOME/SOUL.md` but Tachyon
  neither owns a per-agent Hermes home/profile nor has a verified interactive opening-prompt flag.
- `unsupported`: every other known/unknown runtime.

Classification is syntactic and reuses `resolveBinary`: direct binaries plus `env` and
`npx`/`bunx`/`pnpx` launchers are supported by basename. `bash -lc`, arbitrary wrapper scripts, and
renamed binaries fail closed with a direct-command diagnostic in v1. Basename classification selects
an adapter but does not attest binary provenance. An explicit runtime override is deferred as a
separate parity feature rather than smuggled into `soul`.

`instructions` keeps legacy non-blocking diagnostics. `soul` gets a blocking Studio diagnostic and
a lifecycle error for non-`prompt` capabilities. Do not emulate support with delayed `sendKeys`:
typing into an interactive composer is racy, consumes a turn, and cannot promise opening identity.

Hermes phase 2 begins only after a separate proof records:

- the exact per-agent profile/home selection mechanism;
- auth/config seeding and refresh behavior;
- concurrent agent isolation;
- resume/fork semantics;
- how Tachyon materializes `SOUL.md` without touching ambient `~/.hermes`;
- a live CLI-version dogfood token in `docs/runtimes/parity.md`.

### 7. Make Agent Studio file-oriented and explicit

Add `soul` to `FormState`, `blankAgentFields`, `fromDef`, `toEntry`, dirty snapshots, and the host
adapter entity. Replace “Instructions (role prompt)” with “Persistent instructions”.

Place a new open `Identity (SOUL.md)` section before Role/Instructions:

- relative path input;
- **Select file**: native file picker rooted at the workspace, returning only an accepted relative
  path;
- **Create SOUL.md**: save dialog defaulting to
  `.tachyon/souls/<agent-or-new-agent>/SOUL.md`, then a minimal template write after explicit
  confirmation; revalidate containment after the dialog and use exclusive creation so a raced or
  existing file is never overwritten silently;
- **Open**: open the real file in the editor;
- **Preview**: read-only bounded preview plus source size/digest/status from the host;
- **Clear**: clears the reference only, never deletes the file.

Do not edit the full body in a webview textarea. That avoids two unsaved copies, preserves normal
Markdown/editor tooling, and makes file ownership clear.

Extend the shell protocol with distinct domain messages (`pickSoul`, `createSoul`, `openSoul`,
`refreshSoul`) and typed host replies. All filesystem reads/writes stay in `AgentStudioPanel`/
`AgentStudioAdapter`, not the browser bundle.

Validation/state text must distinguish:

- identity versus role versus persistent instructions;
- “applies on fresh start/restart/re-anchor, not resume/rebind”;
- supported prompt delivery versus Hermes externally managed versus unsupported;
- missing/outside/symlink/invalid/oversize errors;
- rename preserving the old reference;
- “not for secrets”.

Accessibility:

- native labels and button text, deterministic focus order, and keyboard-operable actions;
- `aria-live` status/error updates;
- preview region with an accessible name and scroll behavior;
- no status conveyed by color alone;
- no modal confirmation for read-only select/open/preview; creation uses the native save dialog.

### 8. Document exposure instead of promising secrecy

The feature docs state exactly where a soul can appear:

- source file chosen by the user;
- provider request/runtime transcript;
- process argv for short opening prompts on current positional-argument runtimes;
- `.tachyon/briefs/spawn/<agent>.md` for long composed bodies;
- `.tachyon/anchors/<agent>.md` after re-anchor;
- Activity if it exposes opening transcript content.

Keeping short soul-enabled prompts inline is deliberate: it preserves the same opening-prompt
strength as existing `instructions` and avoids turning identity into a file-read request. The cost
is local argv exposure, so “not confidential / not for secrets” is part of the trust model and R4,
not a hidden implementation detail. If the maintainer prefers forced-file privacy, R4 must change
before implementation and the delivery-strength tradeoff must be re-dogfooded.

Ledger, task records, config diagnostics, and ordinary UI telemetry contain only the relative
reference, digest, sizes, channel, offered/health state, and timestamps. Derived brief/anchor writes
use atomic replace and mode `0600` on POSIX; Windows relies on workspace ACLs and the UI makes no
stronger confidentiality promise. The source creator uses private permissions for the conventional
`.tachyon` path.

Retention is pointer-safe:

- `.tachyon` is already gitignored and a test pins that `souls`/`briefs`/`anchors` remain ignored;
- one brief/anchor path per agent is overwritten on a new offer;
- stop/resume retains the file because the transcript may still contain its pointer;
- permanent dismiss, ledger/ephemeral cleanup, or deletion of a declared agent removes generated
  brief/anchor copies (never the user-authored soul source);
- cleanup tests search for a distinctive body to prove no orphaned generated copy remains.

Do not add heuristic “prompt injection detection”. It gives false confidence and cannot distinguish
strong identity prose from malicious instructions. The meaningful controls are trusted source
ownership, coordinator-root resolution, clear precedence, runtime permission enforcement, and
reviewable diffs.

### 9. Roll out in two implementation checkpoints

**Checkpoint A — core, headless, no UI claim**

- config/source/compositor/capability;
- spawn/restart/resume/rebind/fork/re-anchor/ledger integration;
- full unit and headless capture dogfood;
- documentation labels the feature experimental until Studio lands.

**Checkpoint B — Agent Studio and product closure**

- file actions, preview, validation, accessibility;
- browser tests and Visual QA;
- README/runtime parity;
- two-agent dogfood and compatibility audit.

Hermes native materialization is outside both checkpoints and remains a separately scoped follow-up.

## Key decisions and rejected alternatives

- **Explicit `soul: <path>` per agent (R1)** — chosen because identity is inspectable, reusable, and
  unambiguous; rejected implicit root `SOUL.md` because it creates workspace-global inheritance and
  lets a worktree unexpectedly change identity.
- **Real file, no inline soul (R1)** — chosen because the feature is intended to model durable
  identity and upstream ecosystems use files; rejected inline text because it recreates
  `instructions` with a new label and bloats `tachyon.yml`.
- **Coordinator-root resolution (R1/R4)** — chosen because identity is maintainer-owned control
  context; rejected `cwd`/worktree resolution because an executing agent could modify the identity it
  receives on restart/re-anchor.
- **Typed task layer + legacy serializer (R6)** — chosen because current-task precedence cannot be
  proved while tasks mutate persistent instructions, while a golden-pinned no-soul serializer keeps
  today's task-before-Bridge bytes; rejected both a one-line `soul` prepend (ambiguous lifecycle) and
  a global reorder (breaks every existing agent).
- **Prompt adapter first, native adapter later (R2)** — chosen for one cross-runtime behavior that
  Tachyon already owns; rejected writing Claude/Codex native context files because those files also
  carry repository rules and have different loading/priority semantics.
- **Hermes externally managed in phase 1 (R2)** — chosen because Hermes's native SOUL is global or
  profile-scoped and Tachyon does not own that home; rejected copying into `~/.hermes/SOUL.md` because
  concurrent agents would clobber user state.
- **Fail closed for configured soul (R2/R4)** — chosen because stored-but-unoffered identity is a
  false product claim; deterministic preflight failures stop automatic retries and latch attention,
  with no identity-less fallback. Rejected the legacy `instructions` warning behavior for this new
  field.
- **Reload on restart/re-anchor, not resume/rebind/fork (R3)** — chosen to match transcript
  continuity and avoid duplicated/conflicting identity; rejected “always inject latest” because
  resume and host rebind are not new conversations.
- **No truncation (R4)** — chosen because identity tails can contain limits; rejected upstream-style
  silent truncation in favor of actionable size errors.
- **Raw-byte digest + dual cap (R4)** — chosen so metadata identifies the exact payload and both
  semantic prompt length (20,000 scalar values) and worst-case I/O (64 KiB) are bounded; CRLF/LF
  differences are intentional and error text reports both measurements.
- **Current inline/long-file threshold (R4)** — chosen for opening-delivery strength and compatibility
  with `instructions`; rejected forced-file delivery because it turns every identity into a
  model-followed file-read request. The tradeoff is explicit argv exposure and a hard no-secrets rule.
- **Syntactic runtime classification (R2)** — chosen because it is the existing tested Tachyon seam
  for direct/`env`/package-launcher commands; arbitrary wrappers fail closed until a general runtime
  override is designed.
- **Visible degraded state (R3/R4)** — chosen because a failed post-compaction re-anchor otherwise
  leaves the session silently identity-less; automatic retries pause and digest transitions are
  surfaced without killing the conversation.
- **Path + external editor in Studio (R5)** — chosen to keep one canonical file and normal Markdown
  editing; rejected a large inline editor because it creates concurrent unsaved state and hides the
  source-of-truth boundary.
- **No injection scanner (R4)** — chosen because soul is trusted workspace configuration and model
  prose scanning is not enforcement; rejected keyword heuristics as security theater.
- **No ad-hoc inheritance (R1/R6)** — chosen because identity belongs to a declared principal;
  rejected parent-to-child inheritance because it makes personality contagious and lineage-dependent.

## Files touched

### Core/config

- `src/config/loadConfig.ts` — `soul` field, agent-only structural validation, shared opening-prompt
  capability.
- `src/config/tachyon.schema.json` — schema and user-facing field semantics.
- `src/config/YamlConfigEditor.ts` — path round-trip and terminal sanitization.
- `src/agents/soul.ts` (new) — strict resolver, limits, digest, stable errors.
- `src/agents/promptLayers.ts` (new) — typed layer composition and legacy-compatible renderer.
- `src/roles/templates.ts` — keep role primitives; expose them to the new compositor and retain
  no-soul anchor behavior.
- `src/agents/briefFile.ts` — private/atomic derived writes, exact legacy short-body behavior, and
  pointer-safe retention/cleanup helpers for generated brief/anchor copies.

### Lifecycle/runtime/persistence

- `src/agents/AgentManager.ts` — typed `taskBrief`, resolution, composition, snapshots, lifecycle
  integration, fork/Delivery inheritance.
- `src/agents/LifecycleMonitor.ts` and autostart/schedule/pipeline error seams — classify deterministic
  soul preflight failures, stop retry loops, and latch attention.
- `src/resume/SessionLedger.ts` — defensive optional role/soul/task/snapshot persistence.
- `src/workspace/Workspace.ts` — pipeline task layer and soul-aware re-anchor.
- `src/activity/*` / agent view-model seams — visible `identity-degraded` and digest-transition
  records without storing the soul body.
- `src/bridge/tools.ts` / `src/bridge/spawnContract.ts` — stable external API mapped to task layer.
- Runtime capability seams/tests around `src/resume/adapters.ts` only if the shared classifier belongs
  there; do not add a resume adapter merely to deliver soul.

### Agent Studio

- `src/webview/formLogic.ts` — form field, validation codes, round-trip.
- `src/webview/AgentStudioAdapter.ts` — source status/preview and authoritative save validation.
- `src/webview/AgentStudioPanel.ts` — native file select/create/open actions.
- `src/webview/agent-studio-shell/domain.ts`, `messages.ts`, `types.ts`, `App.tsx`,
  `agent-studio-shell.css` — typed protocol and accessible identity UI.
- `src/webview/agent-studio-fixture/*` — fixture parity if it remains a supported visual route.

### Tests/docs

- `test/unit/soul.test.ts` (new) — path/content/security/limit/digest table.
- `test/unit/promptLayers.test.ts` (new) — order, precedence copy, legacy byte equality.
- `test/unit/config.test.ts`, `agentManager.test.ts`, `resume.test.ts`,
  `roles.test.ts`, `anchor.integration.test.ts` — lifecycle and compatibility.
- `test/unit/agentStudio.test.ts`, `agentStudioAdapter.test.ts`,
  `agentStudioPanel.test.ts`, `webviewShellParity.test.ts` — UI logic/protocol.
- `test/integration/extension.test.js` — config/Studio persistence smoke.
- A new deterministic argv-capture fixture/script for two-agent headless dogfood.
- `README.md`, `docs/funcionalidades.html`, and `docs/runtimes/parity.md` — concepts, config,
  lifecycle, exposure, runtime truth.

## Risks and mitigations

| Risk | Mitigation / proof |
|---|---|
| Prompt order changes existing agents | Conditional legacy renderer plus exact command snapshots with no soul |
| A task is lost while replacing `appendInstructions` | Typed task persistence and spawn/restart/re-anchor tests for ad-hoc, bound Delivery, pipeline, and schedule |
| Identity file escapes workspace or changes during read | Coordinator-root containment, POSIX no-follow + descriptor read/hash, Windows lstat/fstat best effort with residual same-user race documented |
| Invalid soul consumes a worktree/Delivery lease or kills a running pane | Identity preflight at the outer acquisition boundary before those side effects; rollback tests at every spawn/restart entry |
| Unsupported/wrapped runtime silently ignores soul | `resolveBinary`-based capability lookup, explicit wrapper failure, blocking lifecycle error, Studio status, runtime matrix |
| Invalid soul creates unattended retry/outage ambiguity | Deterministic preflight class stops retry, latches attention, records execution failure, and never falls back identity-less |
| Resume receives a duplicate/new identity | Negative resolver/injection assertions on resume and rebind |
| Fork loses future identity after reload | Persist soul reference + offered snapshot on the fork definition/record |
| Re-anchor injects partial/stale content | Resolve/compose/write atomically before terminal input; on failure persist degraded state + attention; show A→B transitions |
| Worktree agent cannot read coordinator anchor | Shell-quoted absolute pointer and a path-with-spaces worktree test |
| Large soul exceeds tmux argument limit | Existing long-brief transport after full composition; max-size tests |
| Soul leaks sensitive text | “Not for secrets” UX/docs, metadata-only ledger, private derived files, explicit argv/transcript/provider disclosure |
| Raw digest differs across CRLF/LF checkouts | Define exact-byte payload/digest and Unicode scalar count; test both forms and document the intentional difference |
| Generated body copies outlive identity | Gitignore assertion, per-agent overwrite, pointer-safe stop/resume retention, permanent cleanup tests |
| Soul prose attempts to override protocol | Trusted-source model, precedence header, machine enforcement remains outside prompt |
| Agent edits its own soul in a worktree | Always resolve from coordinating root |
| UI create leaves an orphan file after form cancel | Creation is an explicit native save action; never delete implicitly; document that clearing/canceling does not delete |
| Hermes integration corrupts ambient profile | Phase-1 unsupported state; separate native-home proof before any materialization |
| Studio protocol grows filesystem logic in browser | Host-only file actions with typed domain messages |
| Subjective dogfood falsely “proves personality” | Mechanical proof checks offered prompt identity; human dogfood is qualitative and labeled advisory |

## Verification strategy

### Unit and integration

- Table-test structural config/path failures and exact diagnostic codes.
- Use temporary real directories/files for containment, symlink, FIFO/special-file, UTF-8, NUL,
  Unicode-scalar count, byte-count, CRLF/LF digest, POSIX no-follow, and documented Windows fallback
  cases.
- Before compositor changes, capture no-soul golden fixtures from immutable baseline
  `23130cea1c1cf8046c1b09ac306de80d92c1bb0e`, store it in a manifest and every fixture, and fail the
  suite if any SHA differs. Make the one-time capture helper refuse when any imported legacy
  production seam differs from that commit; never expose a normal golden-update path through the new
  renderer.
  Byte-compare fresh spawn, restart, no-soul re-anchor, bound Delivery/pipeline task, and the
  pre-existing short/long-brief outputs. Byte-compare BASE_SHA resume/rebind/fork commands and
  send-key payloads too, while spies assert those paths call no prompt serializer/resolver/brief
  compositor. Keep soul-enabled characterization fixtures in a separately named non-parity suite.
- Capture `AgentManager` commands and resolver call counts for spawn/restart/resume/rebind/fork/
  re-anchor.
- Inject source/capability failures and assert no new worktree/stub/Delivery lease/token/harness/pane
  side effect; restart failure preserves the live session.
- Assert a stable descriptor above 64 KiB and either-read sentinel overflow return deterministic
  `too-many-bytes` before change detection and schedule no retry.
- Round-trip old and new ledger rows; assert serialized JSON never contains a distinctive soul body.
- Assert snapshots say `offered` with an accurate channel, never claim provider consumption, and
  degraded/transition records contain no body.
- Test declared, bound Delivery, pipeline, schedule, worktree (including coordinator paths with
  spaces), rename, and parent/subagent behavior.
- Exercise short and long prompt transport.
- Exercise deterministic and unknown-error crash/autostart/schedule/pipeline latching,
  transient-only 2s/4s/8s retry exhaustion, concrete same-handle source-change detection,
  transient human-restart preservation, later-execution recovery, re-anchor degraded recovery, and
  generated-file retention/cleanup.
- Test Studio protocol decoding, dirty restore, create/select/open replies, validation, rename warning,
  and keyboard/ARIA structure.
- Run typecheck, targeted Vitest, browser tests, then `npm run verify:full:quiet`.

### Headless dogfood

Add a deterministic local capture executable under the test/dogfood area and expose a command such as
`npm run dogfood:agent-soul`. It creates a temporary workspace with:

- agents `direct-a` and `direct-b`;
- the same `role: reviewer` and persistent instructions;
- different `SOUL.md` files;
- a runtime name routed through a verified opening-prompt adapter without calling a provider.

The command launches both through the real spawn/composition/shell-quote boundary and asserts:

- each captured opening prompt contains exactly one own soul and zero sibling soul;
- role/instructions/task are equal and ordered correctly;
- ledger JSON contains channel-specific `offered` digests but neither distinctive body;
- editing A then resume does not resolve/inject the edit;
- restart or re-anchor does;
- an invalid restart preserves the live pane, unattended preflight does not retry/fallback, and a
  failed compaction re-anchor records degraded state;
- permanent cleanup removes generated body copies while stop/resume retains live pointers;
- the command exits nonzero on any mismatch.

No paid inference is required.

### Human dogfood

1. In Agent Studio create two Claude or Codex agents with the same reviewer role.
2. Create/select different souls using only keyboard controls; inspect preview and status.
3. Start both and ask the same neutral introduction/review question.
4. Confirm qualitatively distinct voice, then inspect the actual opening prompts/metadata for the
   mechanical proof.
5. Edit one soul; resume and confirm no automatic refresh; restart/re-anchor and confirm refresh.
6. Rename one agent and verify its source path was not moved.

Human observations are recorded as advisory evidence, not an acceptance claim of deterministic model
obedience.

## Visual impact

Agent Studio gains a first-class Identity section and relabels the current instructions section.
Likely visual risks are hierarchy confusion, an overly tall form, long path overflow, preview scroll
behavior, status text competing with validation, and narrow-panel button wrapping.

During implementation run the `visual-qa` skill against the Agent Studio preview/live surface with
this anchor: “Identity is clearly separate and earlier than Role/Persistent instructions; file
actions remain compact, status is readable at narrow width, and advanced worktree/harness sections
retain natural document flow.” Capture normal, missing-file, unsupported-runtime, and long-path
states at wide and narrow widths. Visual QA is advisory; browser/unit gates remain functional proof.

## Sources consulted

### Tachyon code and shipped design

- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json`, and
  `src/config/YamlConfigEditor.ts`.
- `src/roles/templates.ts`, `src/agents/AgentManager.ts`,
  `src/agents/briefFile.ts`, `src/bridge/primer.ts`, and
  `src/bridge/spawnContract.ts`.
- `src/resume/adapters.ts`, `src/resume/SessionLedger.ts`, and the spawn/restart/resume/fork/
  re-anchor paths in `Workspace`.
- Agent Studio host/shell/form modules and their current unit/integration tests.
- `docs/specs/216-tachyon-role-anchoring` — role is an operational contract, not persona; role →
  instructions; resume does not recompose.
- `docs/specs/363-agent-onboarding` — primer is container-owned, full on lifecycle injection
  moments, and protocol enforcement lives outside prose.
- `docs/runtimes/parity.md` — code-backed runtime capability rules and current opening-prompt matrix.

### Upstream primary sources

- OpenClaw, [Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace) — `SOUL.md` is
  persona/tone/boundaries, distinct from operational `AGENTS.md`; workspace files are loaded per
  session and are not secret storage.
- Hermes Agent, [Use SOUL.md with Hermes](https://hermes-agent.nousresearch.com/docs/guides/use-soul-with-hermes)
  and [Prompt assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly) —
  native `$HERMES_HOME/SOUL.md` is primary identity and replaces Hermes's default identity block.
- Installed Hermes Agent `v0.18.2` help (checked 2026-07-13) — `--ignore-rules` skips `AGENTS.md`,
  `SOUL.md`, memory, and skills; interactive mode has no verified generic opening-prompt positional;
  profiles isolate Hermes homes.
- OpenAI Codex manual, `AGENTS.md` hierarchy sections (refreshed through the official manual helper
  on 2026-07-13) — global/project `AGENTS.md` is persistent instruction context assembled at session
  start; Codex documents no native `SOUL.md` slot.

## Ratification gate

Before implementation:

1. maintainer accepts or edits `R1`–`R6`;
2. update `spec.md` from “recommended” to “locked” with the ratification date;
3. split implementation into bounded Mission Control deliveries by the ownership groups in
   `tasks.md`;
4. require a different-model adversarial review of core/security and a separate Visual QA pass for
   Agent Studio before closure.
