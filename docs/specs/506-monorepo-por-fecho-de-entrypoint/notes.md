# 506 — monorepo-por-fecho-de-entrypoint — notes

_Created 2026-08-14._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-08-14 — The 32 measured TS modules keep their original `src/`-relative directory shape under
  `packages/shared/src/`. External consumers use `@tachyon/shared/<original-subpath>`; imports whose
  importer and target are both among the 32 remain relative and inside the package.
- 2026-08-14 — Browser-suite workspace resolution is derived from the root `workspaces` declaration
  and each workspace's `package.json#name`, rather than recognizing only `@tachyon/shared`. An
  unknown `@tachyon/*` specifier fails closed. This costs a small manifest scan at gate startup and
  prevents slices 2/3 from silently narrowing browser coverage when `engine` and `webview-ui` appear.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- 2026-08-14 — The package also carries the three attention JSON assets imported by
  `manifests.ts`. They are not runtime modules and therefore do not change the declared count of 36,
  but leaving them behind would create a real package escape. The shared resolver deliberately
  reports them as the three unresolved non-runtime edges required by the slice.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

### npm workspace measurement (slice 1)

| tree | `npm ci --ignore-scripts` wall time | `package-lock.json` size |
|---|---:|---:|
| before workspaces | 6.90 s | 360,802 bytes |
| after `packages/shared` workspace | 6.88 s | 361,052 bytes |

The measured delta is -0.02 s (noise-level) and +250 bytes (+0.07%). This does not provide evidence
to reopen D1.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Resolved 2026-08-14 — The exact 36-runtime graph exposed 12 type-only import edges that the
  value-edge baseline could not enumerate. The owner restored the full 36-module scope and directed
  extraction of the vocabulary from implementation rather than pruning runtime modules.

## Type-closure measurement and extraction

The independent package compiler first measured **15 unresolved compile edges**: the expected three
JSON assets plus 12 type-only edges. The final package contains **45 source modules**: the original
36 runtime modules plus nine type modules. The two pre-existing type-only modules moved wholesale:
`richDoc/types.ts` (`TiptapJSON`) and `externalTools/types.ts` (`ExternalToolsSummaryVM`). Seven new,
concept-scoped modules hold types extracted without changing their shape:

| shared concept module | type moved out of implementation |
|---|---|
| `agents/managedEntry.ts` | `ManagedEntryInfo` from `AgentManager.ts` |
| `bridge/noticeQueue.ts` | `NoticeQueueMetadata` and its union members from `NoticeQueue.ts` |
| `resume/agentInstance.ts` | `AgentInstanceLifetime`, `AgentInstanceResumePolicy`, `AgentInstancePolicy` from `SessionLedger.ts` |
| `config/entry.ts` | `EntryKind` from `loadConfig.ts` |
| `config/configDiscards.ts` | `ConfigDiscardsVM` from `configDiscards.ts` |
| `config/agentProfile.ts` | the exact `AgentProfileV1` shape formerly inferred only inside `agentProfileSchema.ts` |
| `config/agentProfileLifecycle.ts` | `AgentProfileLifecycleSnapshot` from `agentProfileLifecycle.ts` |

Root implementations import and re-export these addresses for compatibility. The profile schema has
a bidirectional compile-time equality assertion between its Zod inference and the extracted
`AgentProfileV1`, so a later schema/type drift fails typecheck. After extraction,
`tsc -b packages/shared` passes independently and the shared resolver reports only the three JSON
assets. No package-boundary exception was added.

## Verification log

- 2026-08-14 — focused package boundary, type extraction, typecheck and build checks passed. The
  first `verify:full` run correctly failed one stale browser-root expectation (`src/tasks/` had been
  replaced by the measured `packages/shared/` named-import root). After re-measuring and updating
  that reviewed list, `verify:full` passed: 732 files, 8,255 tests passed, 4 live-model tests skipped,
  and 175 browser tests passed. This dirty-tree run is functional evidence only; the final commit is
  re-gated below for attestation.
