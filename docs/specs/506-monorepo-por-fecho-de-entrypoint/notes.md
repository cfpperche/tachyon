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

## Slice 2 — engine closure and address migration

Before moving source, the value/runtime closure of
`src/engine-service/{engineService,daemonMain}.ts` measured **391 modules**: 355 exclusive modules
under `src/` plus the 36 runtime members already owned by `@tachyon/shared`. The independent
type-aware closure measured **422 modules**: 377 under `src/` and all 45 shared source/runtime
modules. Its **31 additional type-only members** were nine shared type modules discovered in slice 1
and 22 modules still under `src/`.

The 355 runtime-exclusive modules moved with `git mv` to `packages/engine/src/`, preserving their
relative shape. Of the 22 extra `src/` type addresses, seven pure-type modules moved wholesale. The
remaining 15 were mixed shell/browser implementations; their exact engine-consumed declarations
moved into six concept modules and the original implementations import and re-export those types.
`StudioDeps` was deliberately not moved because its `vscode.Uri` belongs to the shell; only the
engine-consumed `StudioSubmit` shape moved. The package therefore contains 368 TypeScript source
files physically (355 runtime modules + 7 pure-type modules + 6 extracted concept modules), while
the reproduced value closure still reports exactly **355 engine-owned runtime modules**.

After readdressing, the runtime closure remains **391** and the type-aware closure is **411**. The
20-member difference is now entirely package-owned: 11 type-only modules in `@tachyon/engine` plus
the nine in `@tachyon/shared`. The apparent 422 → 411 reduction is the intended removal of 11
implementation addresses from the type graph: consumers now depend on the extracted concept types,
not on shell/browser implementations.

### Engine artifact comparison

The pre-move daemon was 4,640,240 bytes with SHA-256
`82481e1aef4ab955a1c2544e58e381f8a97081aabd4adf2b31d23c8a5f9af973`. The post-move raw bundle
differs because esbuild emits source-path provenance both as comments and as initializer labels; a
source move necessarily changes those labels. Its SHA-256 is
`8ffbe599eedd977bb4b26a5c9f105ea4203c1c60115c221d3ce40347fbbdce8c`.

Every byte of that difference was classified by normalizing only the two old physical prefixes
(`../../../../../tachyon/{packages/shared,node_modules}/`) and their new package-relative forms
(`../shared/`, `../../node_modules/`). The complete normalized artifacts compare byte-for-byte and
both hash to `1e605a67306e353093bb0d142761f0bdcfeab8990962dec40b76c5b763a6caad`. Thus emitted executable
code and data are identical; only esbuild's source-address labels changed.

## Slice 3 — webview UI closure and address migration

Before moving source, the 27 `main.tsx` entrypoints measured a **206-module runtime closure**:
174 exclusive browser modules under `src/` plus the 32 runtime members already owned by
`@tachyon/shared`. The independent type-aware closure measured **268 modules**. Its 62 additional
members were the nine shared type modules plus 53 modules under `src/`.

The 174 runtime-exclusive modules moved with `git mv` into `packages/webview-ui/src/`, preserving
their relative shape. Type-only dependencies were then made explicit: pure type/protocol modules
moved wholesale and declarations consumed from mixed host implementations were extracted into
concept modules, with compatibility re-exports at the old host addresses. The package contains 203
TypeScript source files physically (174 runtime members plus 29 type-only/concept modules), while
the reproduced runtime closure remains exactly **206 = 174 package-owned + 32 shared**. The final
type-aware closure is **244 = 203 package-owned + 41 shared**; the 268 → 244 reduction is the intended
removal of host implementation addresses from the type graph. The graph reports zero runtime
coupling and zero direct `vscode` imports in both value and type position for all 203 package files.

`themeTokens.ts` deliberately remains a host adapter under `src/webview/ide-browser-bridge`: it
imports `vscode` directly, so moving it would violate the package's stronger zero-`vscode`
invariant. The generated `tokens.css` browser asset moved into the package and the generator/checker
addresses were updated accordingly. The package-boundary exception list remains empty; the checker
continues to report only the three pre-existing shared JSON assets.

### Webview bundle and visual comparison

All 30 top-level webview JavaScript outputs (the 27 requested entrypoints plus three auxiliary
bundles) and all 11 split chunks were compared against the pre-move build. After normalizing only
the content-hash token in split-chunk filenames and the source-provenance prefix
`packages/webview-ui/src/` → `src/`, 28 top-level outputs are byte-identical and the 11 chunk hash
multisets are identical. `plugin-host.js` and `worktrees.js` differ only in minified local identifier
allocation caused by erased TypeScript-only narrowing/type-address changes; their executable AST,
strings, constants and behavior are unchanged. The machine report is
`.tachyon/evidence/t-547fda/bundle-comparison.json`.

The worktree preview harness served all 23 views. Before/after captures cover 23 views × two widths
(880/360) × two themes (dark/light), 92 images per side. 89 pairs are byte-identical. The remaining
three Activity pairs differ in only 88–98 pixels inside the 10×53 animated progress-glyph strip
(maximum channel delta 50); no layout, token, typography, content, or component pixel differs.
Representative screenshots and the complete comparison are recorded under
`.tachyon/evidence/t-547fda/{before,after,visual-comparison.json}`. The viewport harness test passes
all nine assertions.

### Slice 3 verification

The package compiler, root typecheck, browser typecheck, build, package-boundary gate, webview-token
gate, theme-token check, preview viewport suite, graph measurement, and full verification all pass.
The final dirty-tree functional run reports **733 files passed, 8,260 tests passed, four paid
live-model tests skipped, and 175 browser tests passed**. Main was integrated once at the end and was
already identical to the slice base (`770f165a`). A clean committed-tree run follows this log entry
to provide the final verification attestation.
