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

## P0 t-54450c — disk-source scan audit after slice 3

The reported set of 27 was reproduced exactly, but it was the result of a lexical grep, not a useful
boundary: 67 unit-test files both use an `fs` read API and contain a `src` path, while only **12** had
a repository-source enumeration that could still produce a green assertion after examining zero
matching files. Two of those 12 actually named addresses already moved by this SDD at audit start:
`richDocSheetNamespace` named slice 3's old rich-doc directory and failed loudly; two
`landDoorHasNoAgentDoor` cases named slice 2's deleted `src/{bridge,agent-vscode}` directories and
had been silently examining **zero** files because `existsSync` returned `[]`.

The chosen boundary is therefore behavioral: a specific-file `readFileSync` already refuses absence;
a directory/glob/filter enumeration must explicitly refuse an empty filtered result. The 12 changed
enumerators and the number of files they examine on `8b4c3303` plus this fix are:

| test | files examined now | audit result |
|---|---:|---|
| `approvalResolvedByChannel` | 802 TS/TSX | root + all three workspace sources, non-empty |
| `cxWedgeBehavior.gen` | 709 TS | root + all three workspace sources, non-empty |
| `devHostNoSlots` | 1,765 eligible source/docs files | root + all three workspace sources, non-empty |
| `i18n` | 709 TS | root + all three workspace sources, non-empty |
| `landDoorHasNoAgentDoor` | 802 TS/TSX overall; 0 in two stale pre-fix arms | engine actor roots derived; all-product scan non-empty |
| `richDocSheetNamespace` | 17 TS/TSX owner files | webview workspace derived; non-empty per owner |
| `runtimeImportVisibility` | 802 TS/TSX | root + all three workspace sources, non-empty |
| `vscodeThemeBridge` | 14 CSS/TS/TSX | vendor + kit scan non-empty |
| `webviewComponentKit` | 57 TS/TSX | non-empty per declared migrated view |
| `webviewConvention` | 317 host/package TS/TSX/CSS | each semantic subscan refuses empty |
| `webviewCssScope` | 46 CSS | webview workspace derived; non-empty |
| `webviewPreviewCatalog` | 27 host candidates | filtered converted-host scan non-empty |

The original grep's other 23 files are specific-file reads or enumerators whose assertions already
require a known non-empty member/count; they fail loudly and retain their rule unchanged:
`taskDocumentEditPolicy`, `designModeCutoverStructure`, `richDocSketchHostContract`,
`controlRendererRatchet`, `panelTabIcons`, `cxApproval2Behavior.gen`, `activityLayout`, `uiPatterns`,
`workspacePresentationBoundary`, `sidebarPrototype`, `onboardingTemplate`, `singleModeStudioApps`,
`panelWorkGate`, `agentInstanceReaderConvergence`, `probesCutover`, `controlWorkspaceScope`,
`activityCutover`, `sidebarActions`, `quickPickerPackaging`, `appPagePad`,
`settingsScopeCopy`, `systemPanel`, and `panelSourceForm`. The four overlapping changed enumerators
are `approvalResolvedByChannel`, `richDocSheetNamespace`, `webviewConvention`, and
`webviewPreviewCatalog`, yielding the original 27 exactly.

### Slice 5 readdressing inventory

Slice 5 moves the remaining app/host sources under `apps/vscode-extension`; it must readdress these
tests that still deliberately read root `src/` (specific-file reads included):

`taskDocumentEditPolicy`, `designModeCutoverStructure`, `richDocSketchHostContract`,
`controlRendererRatchet`, `panelTabIcons`, `webviewConvention`, `cxApproval2Behavior.gen`,
`webviewPreviewCatalog`, `activityLayout`, `uiPatterns`, `workspacePresentationBoundary`,
`sidebarPrototype`, `onboardingTemplate`, `singleModeStudioApps`, `panelWorkGate`,
`agentInstanceReaderConvergence`, `probesCutover`, `controlWorkspaceScope`, `activityCutover`,
`sidebarActions`, `quickPickerPackaging`, `appPagePad`, `settingsScopeCopy`, `systemPanel`,
`panelSourceForm`, plus the root-source arms of `approvalResolvedByChannel`, `cxWedgeBehavior.gen`,
`devHostNoSlots`, `i18n`, `landDoorHasNoAgentDoor`, and `runtimeImportVisibility`. The latter six must
derive the new app workspace alongside package workspaces; they must not drop the app root from their
non-empty union.
## Slice 4 — residual ownership and slice-5 operational cost

Measured on 2026-08-14 with `node scripts/research/measure-monorepo-graph.mjs` after slices 1–3.
The unit is still the import closure of a real entrypoint, not a directory name. For the app boundary,
the extension and every auxiliary entrypoint configured in `esbuild.mjs` were traversed once with
value edges and once with value + type edges.

### Result and partition

There are **190** `.ts`/`.tsx` files under `src/` today, **22 fewer than the baseline's 212**. The
difference is expected: slices 1–3 moved runtime members and pure-type modules, and extracted new
concept modules inside packages. The current complete partition is:

| measured owner | files | destination in slice 5 |
|---|---:|---|
| VS Code extension shell/runtime closure | **80** | move to `apps/vscode-extension/src/` |
| VS Code webview hosts/adapters in that same closure | **75** | move to `apps/vscode-extension/src/`; these are host-side code, not `webview-ui` |
| auxiliary shipped entrypoints, exclusive of the extension closure | **9** | move to `apps/vscode-extension/src/`; their bundles ship in the same VSIX |
| dev/test/measurement support outside every shipped entrypoint closure | **17** | do **not** move in slice 5; keep in root `src/` for slice 6 disposition |
| compatibility shims outside every shipped entrypoint closure | **8** | do **not** move in slice 5; keep in root `src/` until consumers/tests are readdressed |
| unowned legacy VS Code adapter | **1** | do **not** move in slice 5; keep in root `src/` and decide removal or a real consumer in slice 6 |
| **total** | **190** | **164 move; 26 do not** |

No fourth package is justified. The **26** excluded files do not form one runtime: they split into
test/dev machinery, compatibility addresses and one unowned adapter. Naming a package for that union
would encode absence of ownership as an API.

### The 164 files that move to `apps/vscode-extension`

The extension's **155-file type-aware closure** is 153 runtime members plus two compile-only members
(`presentation/items.ts` and `webview/ServerInspector.ts`). Its 80 shell/runtime files are:

```text
src/activity/activityShare.ts
src/activity/activityView.ts
src/agents/savedAgentProposalCommit.ts
src/agents/savedAgentProposalReview.ts
src/agents/savedAgentRemovalProposalCommit.ts
src/agents/savedAgentRemovalProposalReview.ts
src/config/settingsImport.ts
src/engine-service/devHostBoundary.ts
src/engine-service/engineCurrency.ts
src/extension.ts
src/externalTools/events.ts
src/humanInbox/artifacts.ts
src/humanInbox/deepLink.ts
src/init/initLogic.ts
src/inspector/classify.ts
src/inspector/model.ts
src/plugins/appliedState.ts
src/plugins/consentViewModel.ts
src/plugins/dataLauncher.ts
src/plugins/dataPlan.ts
src/plugins/engine.ts
src/plugins/entryHtmlValidator.ts
src/plugins/externalTool.ts
src/plugins/fetcher.ts
src/plugins/fsx.ts
src/plugins/gitHookRegistry.ts
src/plugins/gitHookState.ts
src/plugins/gitRepo.ts
src/plugins/i18nPtbrGate.ts
src/plugins/mcpConfig.ts
src/plugins/pluginDeps.ts
src/plugins/skill.ts
src/plugins/source.ts
src/plugins/toolLauncher.ts
src/plugins/toolPlaceholder.ts
src/plugins/toolPlan.ts
src/plugins/toolPlatform.ts
src/plugins/toolProvisionRun.ts
src/plugins/toolProvisioning.ts
src/plugins/toolTransaction.ts
src/plugins/ui/broker.ts
src/plugins/ui/host.ts
src/plugins/ui/projectionBuilder.ts
src/plugins/ui/projectionProvider.ts
src/plugins/viewModel.ts
src/presentation/Terminals.ts
src/presentation/TmuxAttachClient.ts
src/presentation/agentPaneFont.ts
src/presentation/contextValue.ts
src/presentation/items.ts
src/presentation/sessionViewport.ts
src/provenance/record.ts
src/provenance/verify.ts
src/runtime-api/workspaceProjection.ts
src/runtimeConfig/claudeInventory.ts
src/runtimeConfig/codexInventory.ts
src/runtimeConfig/grokInventory.ts
src/runtimeConfig/sourceLock.ts
src/runtimeOps/openRuntimeOps.ts
src/sections/resolveSection.ts
src/sections/route.ts
src/shell/ActivityTarget.ts
src/shell/BoardTarget.ts
src/shell/ClientWorkspaceStudioTarget.ts
src/shell/HandoffTarget.ts
src/shell/PinStudioTarget.ts
src/shell/RuntimeOpsTarget.ts
src/shell/SidebarTarget.ts
src/shell/TaskDetailTarget.ts
src/shell/TaskStudioTarget.ts
src/shell/WorkspaceClient.ts
src/shell/WorkspaceClientRegistry.ts
src/shell/WorkspaceExtensionTarget.ts
src/shell/WorkspacePresentation.ts
src/shell/WorkspaceShellHandle.ts
src/workspace/NotificationService.ts
src/workspace/legacyVsCodeSettings.ts
src/workspace/notify.ts
src/workspace/shellDiagnosticLog.ts
src/workspace/workspaceFolderOps.ts
```

The 75 host-side webview files in the same closure are:

```text
src/webview/ActivityPanel.ts
src/webview/AgentPanePanel.ts
src/webview/AgentStudioAdapter.ts
src/webview/AgentStudioPanel.ts
src/webview/BoardPanel.ts
src/webview/CommandStudioAdapter.ts
src/webview/CommandStudioPanel.ts
src/webview/HandoffPanel.ts
src/webview/HumanInboxPanel.ts
src/webview/PinDetailPanel.ts
src/webview/PinStudioAdapter.ts
src/webview/PinStudioPanel.ts
src/webview/PipelineStudioPanel.ts
src/webview/PluginsPanel.ts
src/webview/ProbeResultPanel.ts
src/webview/RunbookStudioAdapter.ts
src/webview/RunbookStudioPanel.ts
src/webview/RuntimeConfigPanel.ts
src/webview/RuntimeOpsPanel.ts
src/webview/ScheduleStudioAdapter.ts
src/webview/ScheduleStudioPanel.ts
src/webview/ServerInspector.ts
src/webview/SettingsPanel.ts
src/webview/SidebarPrototype.ts
src/webview/SystemPanel.ts
src/webview/TaskDetailPanel.ts
src/webview/TaskStudioAdapter.ts
src/webview/TaskStudioPanel.ts
src/webview/TerminalStudioAdapter.ts
src/webview/TerminalStudioPanel.ts
src/webview/TmuxPanel.ts
src/webview/WorktreesPanel.ts
src/webview/activity/activityFeed.ts
src/webview/agent-pane/protocol.ts
src/webview/agent-studio-shell/agentStudioDomain.ts
src/webview/agentPaneDelivery.ts
src/webview/approval/viewModel.ts
src/webview/board/boardVm.ts
src/webview/chat-bridge/ops.ts
src/webview/chat-bridge/parse.ts
src/webview/chat-bridge/register.ts
src/webview/controlStrings.ts
src/webview/human-inbox/viewModel.ts
src/webview/ide-browser-bridge/browserSession.ts
src/webview/ide-browser-bridge/cdpSession.ts
src/webview/ide-browser-bridge/designModeInject.ts
src/webview/ide-browser-bridge/homeUrl.ts
src/webview/ide-browser-bridge/hostServer.ts
src/webview/ide-browser-bridge/manager.ts
src/webview/ide-browser-bridge/pick.ts
src/webview/ide-browser-bridge/register.ts
src/webview/ide-browser-bridge/themeTokens.ts
src/webview/pin-preview/editPolicy.ts
src/webview/pin-studio/pinStudioDomain.ts
src/webview/pipelineStudioAdapter.ts
src/webview/shared/ControlWorkspaceScope.ts
src/webview/shared/SectionPanelManager.ts
src/webview/shared/panelIcon.ts
src/webview/shared/panelSerializer.ts
src/webview/shared/panelWorkGate.ts
src/webview/shared/shell.ts
src/webview/shared/studio/SingleModeStudioPanelManager.ts
src/webview/shared/studio/StudioPanelManagerBase.ts
src/webview/shared/studio/documentStudioCancel.ts
src/webview/shared/studio/errorTaxonomy.ts
src/webview/shared/studio/restoreDecisions.ts
src/webview/shared/studio/singleModeEditPolicy.ts
src/webview/shared/studio/studioIds.ts
src/webview/shared/studio/studioRegistry.ts
src/webview/studioSubmit.ts
src/webview/task-detail/editPolicy.ts
src/webview/task-detail/taskDetailVm.ts
src/webview/task-detail/taskStudioDomain.ts
src/webview/validations/viewModel.ts
src/webview/webviewApps.ts
```

The nine exclusive auxiliary-entry files are nominally measured, not estimated:

| bundle/entry | exclusive files that move | reason |
|---|---|---|
| tool launcher | `src/toolLauncherEntry.ts` | shipped `dist/tool-launcher.cjs`; its other four members are already in the extension closure |
| plugin validator | `src/pluginValidateEntry.ts` | shipped `dist/plugin-validate.cjs` |
| data resolver | `src/dataResolverEntry.ts` | shipped `dist/data-resolver.cjs`; its other member is already in the extension closure |
| external resolver | `src/externalResolverEntry.ts` | shipped `dist/external-resolver.cjs`; its other two members are already in the extension closure |
| Pi bridge | `src/pi-bridge-extension/index.ts`, `src/pi-bridge-extension/toolProjection.ts` | shipped under `dist/engine/` in this VSIX |
| webview auxiliary assets | `src/webview/activity/katex-entry.ts`, `src/webview/activity/mermaid-entry.ts`, `src/webview/pin-studio/excalidraw-entry.tsx` | three shipped `dist/webview/*.js` assets |

Therefore slice 5 is **smaller than the plan's stale 212-file residual premise: 164 source files
move, 48 fewer than 212**. This is not a request to delete the other 26; their explicit destinations
follow.

### The 26 files that do not move in slice 5

Seventeen files remain root-owned test/dev/measurement support. None is reached from the nine shipped
entrypoints measured above:

| files | why not app-owned; declared destination |
|---|---|
| `src/agents/formation/humanLaneTransactions.ts`, `src/agents/formation/lifecycleContract.ts`, `src/agents/formation/memoryLane.ts`, `src/agents/formation/resolver.ts`, `src/agents/formation/sessionPolicy.ts`, `src/memory/domain.ts` | formation foundation/proof modules reached by tests/static scans, not a shipped entrypoint; remain in root `src/` for slice 6 |
| `src/config/argvCommand.ts` | unit-test-only parser; remain for slice 6 |
| `src/runtime/adapters/claudeMemory.ts`, `src/runtime/adapters/codexMemory.ts`, `src/runtime/nativeLaneSuppression.ts`, `src/runtimeObservability/grokInspectConfigSource.ts` | runtime measurement/test implementations, not shipped app closure; remain for slice 6 |
| `src/shell/FakeWorkspaceClient.ts` | test fake used by shell tests; remain for slice 6 |
| `src/webview/AgentFixtureStudioPanel.ts`, `src/webview/SectionAppFixturePanel.ts` | explicitly dev-only fixture hosts; remain for slice 6 rather than ship as product hosts |
| `src/webview/shared/lazySectionStyles.ts` | test-only browser helper no longer reached by a current browser entrypoint; remain for slice 6 |
| `src/webview/surfaces.ts` | static convention/preview manifest consumed by checks and tests; remain for slice 6 |
| `src/webview/ui-gate/gatePage.ts` | browser-gate/test server page renderer; remain for slice 6 |

Eight compatibility addresses remain until their consumers/tests are readdressed; moving them into
the app would turn historical import compatibility into an app API:

```text
src/config/runtimePromptAdapters.ts
src/webview/approval/App.tsx
src/webview/approval/messages.ts
src/webview/pin-studio/data-url.ts
src/webview/pin-studio/document.ts
src/webview/pin-studio/tiptap.ts
src/webview/validations/App.tsx
src/webview/validations/messages.ts
```

Finally, `src/workspace/VsCodeHost.ts` imports `vscode` in value position but has no production or
test importer today. It is neither evidence for a package nor silently app-owned: it remains in root
`src/` for slice 6 to choose deletion or establish a real entrypoint consumer.

### VS Code coupling inside the 190 residual files

The baseline's runtime result remains exactly **50**, but the type-aware result changed from 88 to
**79** after type extraction. Counted separately:

| destination | runtime-coupled | type-aware-coupled | direct value import | direct type-only import |
|---|---:|---:|---:|---:|
| moves to `apps/vscode-extension` (164 files) | **47** | **76** | **39** | **9** |
| does not move in slice 5 (26 files) | **3** | **3** | **3** | **0** |
| **all residual `src/`** | **50** | **79** | **42** | **9** |

The three coupled files outside the app move are the two explicitly dev-only hosts
`AgentFixtureStudioPanel.ts` and `SectionAppFixturePanel.ts`, plus the unowned `VsCodeHost.ts`.
The other 47 runtime-coupled files all have an app destination. The **29-file 79 − 50 difference**
is type-only propagation, not runtime coupling; all 29 are in the 164-file app move.

For nominal audit, the 47 runtime-coupled files moving to the app are:

```text
src/extension.ts
src/plugins/ui/host.ts
src/presentation/Terminals.ts
src/presentation/TmuxAttachClient.ts
src/runtimeOps/openRuntimeOps.ts
src/webview/ActivityPanel.ts
src/webview/AgentPanePanel.ts
src/webview/AgentStudioPanel.ts
src/webview/BoardPanel.ts
src/webview/CommandStudioPanel.ts
src/webview/HandoffPanel.ts
src/webview/HumanInboxPanel.ts
src/webview/PinDetailPanel.ts
src/webview/PipelineStudioPanel.ts
src/webview/PluginsPanel.ts
src/webview/ProbeResultPanel.ts
src/webview/RunbookStudioPanel.ts
src/webview/RuntimeConfigPanel.ts
src/webview/RuntimeOpsPanel.ts
src/webview/ScheduleStudioPanel.ts
src/webview/SettingsPanel.ts
src/webview/SidebarPrototype.ts
src/webview/SystemPanel.ts
src/webview/TaskDetailPanel.ts
src/webview/TerminalStudioPanel.ts
src/webview/TmuxPanel.ts
src/webview/WorktreesPanel.ts
src/webview/agent-studio-shell/agentStudioDomain.ts
src/webview/chat-bridge/register.ts
src/webview/controlStrings.ts
src/webview/ide-browser-bridge/browserSession.ts
src/webview/ide-browser-bridge/cdpSession.ts
src/webview/ide-browser-bridge/designModeInject.ts
src/webview/ide-browser-bridge/manager.ts
src/webview/ide-browser-bridge/register.ts
src/webview/ide-browser-bridge/themeTokens.ts
src/webview/shared/SectionPanelManager.ts
src/webview/shared/panelIcon.ts
src/webview/shared/panelSerializer.ts
src/webview/shared/studio/SingleModeStudioPanelManager.ts
src/webview/shared/studio/StudioPanelManagerBase.ts
src/webview/shared/studio/documentStudioCancel.ts
src/webview/shared/studio/studioRegistry.ts
src/webview/task-detail/taskStudioDomain.ts
src/workspace/legacyVsCodeSettings.ts
src/workspace/notify.ts
src/workspace/shellDiagnosticLog.ts
```

The 29 additional type-aware-only files, all moving to the app, are:

```text
src/presentation/items.ts
src/shell/ActivityTarget.ts
src/shell/BoardTarget.ts
src/shell/ClientWorkspaceStudioTarget.ts
src/shell/HandoffTarget.ts
src/shell/PinStudioTarget.ts
src/shell/RuntimeOpsTarget.ts
src/shell/SidebarTarget.ts
src/shell/TaskDetailTarget.ts
src/shell/TaskStudioTarget.ts
src/shell/WorkspaceExtensionTarget.ts
src/shell/WorkspacePresentation.ts
src/shell/WorkspaceShellHandle.ts
src/webview/AgentStudioAdapter.ts
src/webview/CommandStudioAdapter.ts
src/webview/PinStudioAdapter.ts
src/webview/PinStudioPanel.ts
src/webview/RunbookStudioAdapter.ts
src/webview/ScheduleStudioAdapter.ts
src/webview/TaskStudioAdapter.ts
src/webview/TaskStudioPanel.ts
src/webview/TerminalStudioAdapter.ts
src/webview/activity/activityFeed.ts
src/webview/board/boardVm.ts
src/webview/pin-studio/pinStudioDomain.ts
src/webview/shared/ControlWorkspaceScope.ts
src/webview/shared/panelWorkGate.ts
src/webview/studioSubmit.ts
src/webview/task-detail/taskDetailVm.ts
```

### Re-measurement of the 18 operational files

The nominal union is still **18/18 files**: none disappeared and no nineteenth file now owns a root
manifest, flat product `dist/`, or checkout-wide gate/F5 assumption. Slices 1–3 did change their
state: workspace-aware root orchestration now exists, while the extension packaging path is still
root-relative.

| file | current measured assumption and slice-5 consequence | break order |
|---|---|---:|
| `package.json` | still the extension manifest; `main` is `./dist/extension.js` and `vscode:prepublish` invokes root packaging, while `workspaces` contains only `packages/*`; must split product manifest from root orchestrator and add the app workspace | 1 |
| `.vscodeignore` | still packages root `dist/**` and root `package.json`; vsce selection is wrong immediately after manifest relocation | 1 |
| `esbuild.mjs` | still reads root `package.json`; has **19 `outfile` + 1 `outdir` configurations** under flat root `dist/` (still 20 output configurations) and 94 quoted `dist/` path literals; must derive the app output root | 2 |
| `scripts/prepare-package.mjs` | defaults `root = process.cwd()`, edits root `package.json`, prunes root `dist/`, and launches root-relative provenance | 1 then 2 |
| `scripts/package-closure.mjs` | accepts an extension root but expects `package.json`, `node_modules` and `dist/*` beneath that same root; caller and dependency-root semantics must be separated | 2 |
| `scripts/record-provenance.mjs` | binds cwd to manifest, VSIX search, `dist/`, audit output and `npm run verify:full`; needs separate repository and extension roots | 2 |
| `scripts/vsix-smoke.mjs` | finds VSIX in checkout root but correctly reads the unpacked extension's own manifest; discovery/probe root must be made explicit after relocation | 1 |
| `scripts/dev-host/pointer.mjs` | validates and names the worktree root itself as extension path, requiring its `package.json`, `node_modules` and `dist/`; must point F5 at the app while retaining repository/fixture roots | 3 |
| `scripts/ship-boundary.mjs` | models `dist/engine` under the packaged extension root; caller must pass the relocated app tree | 2 |
| `scripts/vsix-artifact.mjs` | claims `dist/*` and hard-codes `dist/engine` relative to extension root; artifact root must follow the manifest | 2 |
| `.vscode/launch.json` | still has exactly **five** `${workspaceFolder}[/...]/dist/**/*.js` outFiles references; development path/outFiles must target the app/pointer app | 3 |
| `package-lock.json` | already records all three package workspaces; slice 5 adds the app workspace, so the root install model survives but lockfile changes | 4 |
| `tsconfig.json` | already references the three packages and uses rootDir `.`; needs an app project reference/root without undoing root orchestration | 4 |
| `tsconfig.webview.json` | already resolves `packages/webview-ui`; any remaining app-host sources/includes must follow their move | 4 |
| `.vscode/tasks.json` | still builds with cwd/prefix equal to the pointed extension worktree root and links root `node_modules`; must distinguish repo root from app root | 3 |
| `.github/workflows/ci.yml` | already runs `npm ci` and `npm run verify:full` at workspace root; no first-order break if root remains orchestrator, but it must prove the new app workspace | 4 |
| `scripts/verify-full.mjs` | now derives browser roots from root workspaces, so it is already plural for packages; it must discover `apps/*` via the updated workspace manifest, not a literal app name | 4 |
| `scripts/verify-record.mjs` | correctly attests the whole git tree; its model can remain checkout-wide, but its verifier fingerprint must cover the relocated scripts/manifest | 4 |

The current order therefore remains **(1) manifest/vsce, (2) build/staging, (3) F5/dev-host,
(4) gate/CI**. `package.json#main` and vsce still break first. What changed is the tail: CI and the
verification record no longer need a new execution unit, because slices 1–3 made the checkout a
workspace orchestrator; they need discovery/coverage updates, not relocation. The highest immediate
cost remains the manifest boundary plus `esbuild.mjs`, while the five F5 paths remain a separate
owner-visible risk.

### Slice 5 implementation record

- The measured move was executed as exactly **164/164** byte-identical source relocations. The
  residual root `src/` remains exactly **26** TypeScript files, including the intentionally orphaned
  `src/workspace/VsCodeHost.ts`.
- The root manifest is now orchestration-only and discovers `apps/*` plus `packages/*`; the extension
  manifest remains version `0.91.0` with `main: ./dist/extension.js`.
- Build, package, provenance, VSIX smoke and dev-host paths discover the extension workspace by its
  `engines.vscode` manifest contract. `workspaceLayout.test.ts` proves another `apps/*` child is
  discovered without changing the resolver.
- `vsce` cannot walk npm's hoisted monorepo tree without reporting unrelated development packages as
  extraneous. The release therefore stages the sole native external (`node-pty`) under
  `dist/node_modules`, records it in provenance, and calls `vsce --no-dependencies`; README and LICENSE
  are staged beside the app manifest only for the packaging callback.
- Headless build, TypeScript, focused relocation tests, package-boundary and engine-boundary checks
  are green. The human F5 proof remains an explicit exit condition and is not represented as complete here.

### Slice 5 stable artifact comparison

- A standalone clean clone of pre-slice commit `a42f2358` produced a stable `0.91.0` VSIX; a clean
  clone of post-slice commit `571b8214` produced another. Both unpack to exactly **346 files**.
- After normalizing the deliberate native dependency relocation
  `node_modules/node-pty/** -> dist/node_modules/node-pty/**`, the file inventories differ only in the
  eleven content-hashed webview chunk names. Those names and their import references changed because
  esbuild's physical entrypoint/source addresses changed; payload byte sizes are unchanged.
- Of the same-address files, **329 are byte-identical** after normalizing the source prefix and chunk
  hash names. The four expected semantic differences are: product `package.json` drops the former
  root `workspaces` field; `extension.js` embeds the new commit/tree attestation; the engine manifest
  carries that same attestation (and the derived Pi bundle hash); and `provenance.json` records the
  new tree plus relocated dist dependency paths.
- The post-slice `npm run release` completed its real VSIX smoke: closure passed, VS Code `1.133.0`
  installed the package, the persistent engine answered, all **99/99** declared commands registered,
  both contributed views focused, and the node-missing run refused by `EngineBundleError`.
- The only remaining slice-5 checkbox is the maintainer-owned F5 proof in the real development host.

### 2026-08-14T18:41:03Z — fail (0/1) — source: tasks.md
- `npm run verify:full` — fail

### 2026-08-14T18:48:20Z — pass (1/1) — source: tasks.md
- `npm run verify:full` — pass

## Slice 6 — final measurement and closure

The first final run of `measure-monorepo-graph.mjs` reported **642** files and ten relative imports
to `apps/vscode-extension` as unresolved. That was not the final repository graph: the script still
read root `src/` plus packages and omitted all **164** app sources moved in slice 5. The measurement
now derives VS Code app roots from root workspaces (`engines.vscode`), measures **805** physical
source/runtime files, and has exactly the original three nominal unresolved JSON assets. Final
counts and every forecast divergence are recorded beside the initial numbers in
`docs/architecture/tachyon-monorepo-transitive-baseline.md`.

The 26 residual root sources reproduced slice 4's groups exactly. Their disposition is:

- **17** dev/test/measurement support modules stay in root `src/` as their definitive repository
  owner; no shipped entrypoint reaches them and they do not form one runtime.
- **8** compatibility addresses are temporary debt. Task `t-31bedf` names all eight, requires their
  consumers to use the owning workspace address, and forbids inventing a package for the union.
- **1** orphan, `src/workspace/VsCodeHost.ts`, had zero production and test importers and was deleted.
  The final typecheck, build and boundary gates prove no missing consumer; root `src/` now has **25**
  files and runtime `vscode` coupling falls from 50 to **49**.

The generic ignore rule is now `node_modules` rather than `node_modules/`. A real symlink created at
`apps/vscode-extension/node_modules` is matched by `.gitignore:1`; `git status` reports no untracked
path. This applies at any depth and does not name the current app.

The coordinator reconciled historical task `t-e4348c` from triaged to done, pointing to SDD 506 and
preserving the July assessment as historical evidence. The slice agent deliberately did not triage
the inbox task merely because it was adjacent to this work.

## Dogfood log

### 2026-08-14T18:48:20Z — pass (1/1) — source: slice 5 release evidence
- `npm run smoke:vsix` — pass as the smoke phase of `npm run release`: VS Code 1.133.0 installed the
  VSIX, the engine answered, 99/99 commands registered and both contributed views focused.
