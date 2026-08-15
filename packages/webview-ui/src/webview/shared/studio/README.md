# studio shell (spec 350, Phase 1)

The shared infrastructure every studio dialect (Pin, Task, and — post-dismemberment — the five Agent-entity
studios) is meant to become thin configuration over. Phase 1 proves the shell against two fakes that cannot
become casualties: **Pipeline Studio** (`../../pipeline-studio/`, a behaviorally-complete fake with in-memory
persistence) and the **Agent-entity fixture** (`../../agent-studio-fixture/`, a region-composition proof).
Neither ships a command; both are dev-tooling/test/preview-only surfaces. No existing studio is touched by
this delivery — Task Studio's migration is Phase 2, gated on this doc + both fakes' tests passing.

## Files

| File | Side | Owns |
|---|---|---|
| `protocol.ts` | shared, DOM-free | `StudioMessage` envelope, protocol version, core message names, fail-closed decode, domain-name collision guard |
| `errorTaxonomy.ts` | shared, DOM-free | `StudioError`/`StudioValidationResult`, unknown-source-is-blocking default |
| `dirtyGating.ts` | shared, DOM-free | `canSave`, `requiresDiscardConfirmation` — pure save/discard gate decisions |
| `restoreDecisions.ts` | shared, DOM-free | `decideRestore` — fail-closed-on-load-failure panel restore decision |
| `adapter.ts` | shared, DOM-free | `StudioHostAdapter<TEntity,TFields,TPatch>` — the type contract an adapter implements |
| `StudioPanelManagerBase.ts` | host (vscode) | panel lifecycle (open/reveal/dispose/refreshAll), protocol dispatch, restore capture/replay |
| `StudioFrame.tsx` | webview (Preact) | header, Cancel/Save (shell-owned gating), error/stale/load-error banners, the four content regions |
| `studio-frame.css` | webview | the frame's own chrome — NOT a reuse of `rich-doc.css`'s entity-neutral editor styles |

## Adapter surface budget

Every hook a `StudioHostAdapter` exposes maps to exactly ONE of these categories. A hook that doesn't fit
one of these is a bypass and is **forbidden without a spec amendment** — "thin configuration" is a checkable
property of this table, not a hope (dueto F9).

| Category | Hooks | What it may NOT do |
|---|---|---|
| Identity/lifecycle | `entityType`, `titleFor` | Reach into panel creation, dispatch, or dirty/save/error flow |
| Layout regions | `StudioFrame`'s `regions.{fields,richDoc,previewVisual,sideActions}` (adapter-authored JSX passed in by the surface's own `App.tsx`, not a hook on `StudioHostAdapter` itself) | Add a FIFTH region, or render outside the four (Pin's future migration must name what can't map, not invent a fifth slot) |
| Domain fields | the surface's own `App.tsx`/`domain.ts` (fields state, per-field change handlers) | Bypass `StudioFrame`'s header/Cancel/Save — a domain component only ever lives INSIDE a region |
| Validation | `validate(fields): StudioValidationResult` | Decide blocking for a code it doesn't own (unknown = blocking is the SHELL's default, not overridable) |
| Persistence | `load`, `save`, `delete?` | Skip the error taxonomy on failure — `save()`'s error result MUST carry a `source` the base maps through `postError` unchanged |
| Concurrency | `concurrency: ConcurrencyContract`, `revisionOf?` | Implement its own stale-banner UI — `StudioFrame`'s `concurrencyStale`/`onReload` own that |
| Domain actions | the `onDomainMessage` constructor callback (`StudioPanelManagerBase`) + the adapter's `domainMessageNames` | Register a name colliding with a core message (`protocol.ts`'s `assertNoDomainNameCollision` throws); reply with anything but `ctx.post(...)` (never touch the raw vscode panel) |
| Dirty tracking | `dirty.{computeDirty,serializePatch,canDiscard}` | Be inferred by the shell from field diffing — always adapter-declared (dueto F5/F6), never global |

**Two recurring domain-action patterns** (documented here per the T6 AgentForm spike, not new primitives —
both fit the table above unchanged):
- **Native picker round trip**: webview asks, host runs `vscode.window.showOpenDialog`/similar, replies with
  the picked value (Pin/Task's `importImage`; Agent Studio's `browse`).
- **Infer-and-suggest round trip**: webview sends a raw value, host applies domain logic and suggests a
  follow-up action (Fake 1's `importStages`/`stagesImported`; AgentForm's pre-dismemberment `inferKind`).

## Known gap (recorded, not fixed in Phase 1)

`StudioLoadResult<TEntity>` (`adapter.ts`) has no slot for adapter-declared REFERENCE data that isn't part of
the entity itself but the form needs to render (quick-add chips, taken names, known-agent lists — see
`docs/specs/350-studio-shell/notes.md`'s T6 spike). Needed before the Agent dismemberment task, not before
Phase 1 exits — Fake 1 and the Agent fixture don't need it.

## Import matrix (who may import what)

```
shared/studio/*.ts (pure)         <- StudioPanelManagerBase.ts (host)
shared/studio/*.ts (pure)         <- StudioFrame.tsx (webview)
shared/studio/StudioFrame.tsx     <- <surface>/App.tsx (webview)   e.g. pipeline-studio/App.tsx
shared/studio/StudioPanelManagerBase.ts <- apps/vscode-extension/src/webview/<Surface>Panel.ts (host)  e.g. PipelineStudioPanel.ts
<surface>/domain.ts (vscode-free) <- both <surface>/App.tsx (webview) AND apps/vscode-extension/src/webview/<surface>AdapterOrPanel (host)
```

The shell composes `shared/ui` (kit); it is never composed BY kit. A surface's webview code never imports
its own host `*Panel.ts` (and vice versa isn't an import — the host owns wiring, the protocol is the only
channel). See `pipeline-studio/` for the reference shape: `domain.ts` (dual-compilable pure logic) +
`types.ts`/`messages.ts` (webview-side protocol types) + `App.tsx`/`main.tsx` (webview) on one side,
`pipelineStudioAdapter.ts` (host, in-memory store) + `PipelineStudioPanel.ts` (host, vscode wiring) on the
other.

## Phase 1 exit criteria (this doc's job)

Shell lifecycle + protocol tests green against BOTH fakes (`test/unit/studioShell.test.ts`,
`test/unit/studioPanelBase.test.ts`, `test/unit/pipelineStudioPanel.test.ts`,
`test/unit/agentStudioFixture.test.ts`); this budget documented and reviewed BEFORE any real migration;
restore proven across a simulated reload; error taxonomy save-gating proven; the AgentForm spike recorded
(`notes.md`). Phase 2 (Task Studio migration) and the Agent dismemberment are follow-up tasks gated on all
of the above, not on this file's existence alone.
