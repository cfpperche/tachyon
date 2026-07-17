# 396 — engine-stable-dev-channels — plan

_Drafted from `spec.md` on 2026-07-17. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a release channel to the existing immutable engine manifest and propagate it into the live service identity.
The parser remains backward-compatible with manifests/identities that predate the field, while every newly built
bundle is stamped `stable` or `dev`.  Bundle identity includes the channel when present.

Make `dev` the default for ordinary `npm run build`.  The VSIX prepublish path explicitly requests `stable` and
runs a Git source gate before building: primary checkout, branch `main`, clean tree, and equal `HEAD`, `main`, and
`origin/main`.  Package preparation independently rechecks the gate and verifies that the emitted manifest's
channel/commit/tree match the checkout, closing stale-dist and manual-environment mistakes.

The packaged workspace client receives the channel expected by the VS Code extension mode. Production accepts
only `stable`; development accepts only `dev`.  Development additionally requires a marker written by both Dev
Host launch paths.  Those paths set private XDG cache/data/state roots.  This keeps a worktree build out of the
installed production lane even if both artifacts exist on the same machine.

Extend supervisor classification with channel-aware behavior. Stable same-version/different-content is a hard
error that requires a version bump. Dev same-version rebuilds use the already serialized upgrade/rollback path.
Crossing between explicit stable and dev identities fails closed. Legacy-unmarked engines remain readable so the
first newer stable release and rollback can migrate the current 0.56.17 installation.

## Key decisions

- **Channel is embedded provenance, not a runtime setting** — the installed bytes carry their origin and cannot be relabeled by `tachyon.yml`; a workspace setting was rejected because projects must not authorize engine promotion.
- **Stable means exact cached `origin/main` at build time** — equality is deterministic and testable; ancestry-only was rejected because it would still allow feature commits or stale local main builds.
- **Ordinary builds default to dev** — accidental local builds fail safe; default-stable was rejected because every clean worktree would remain packageable.
- **Stable same-version drift is an error** — version becomes the monotonic production transition key; silently adopting by bundle id was rejected because older shells could cause ping-pong, while silent reuse is the current defect `t-415444`.
- **Dev same-version drift may upgrade** — iterative F5 dogfood must see changed code without production version churn; this is permitted only after the Dev Host marker/channel gates.
- **Legacy fields remain optional at the wire/storage boundary** — the current engine must be upgradeable and usable as rollback material; treating legacy as a valid new production build was rejected.
- **No direct source execution** — immutable staged bundles preserve restart, integrity and rollback semantics from spec 382.

## Files touched

- `esbuild.mjs`, `scripts/engine-release-channel.mjs`, `scripts/package-clean-gate.mjs`, `scripts/prepare-package.mjs`, `scripts/record-provenance.mjs`, `package.json` — channel stamping and canonical-main stable gate.
- `src/engine-service/{protocol,engineBundleStore,engineSupervisor,engineService}.ts` — manifest/identity validation, staging policy and transition rules.
- `src/shell/WorkspaceClient.ts`, `src/extension.ts`, `src/engine-service/devHostBoundary.ts` — production/development expected-channel and marked-workspace gate.
- `.vscode/tasks.json`, `scripts/dev-host/{pointer.mjs,cli.sh}`, `docs/runbooks/dev-host.md` — mark and isolate both Dev Host launch paths.
- Focused unit/behavior tests around packaging, bundle staging, supervisor transitions, workspace connection and Dev Host configuration.

## Risks & unknowns

- The new daemon must be able to launch a legacy rollback bundle without passing an option its old decoder rejects; channel is therefore omitted when the legacy manifest lacks it.
- Old shells must tolerate the additive identity field; current validators already ignore extra keys, but mixed-version supervisor tests will cover migration.
- Dev Host currently isolates cache/tmux and workspace path but not XDG state/data; both F5 and CLI launch paths must be forced by tests.
- Stable build tests use temporary Git repositories and cached remote refs; no test or package command may mutate or fetch the real remote.
- Main can advance while this isolated branch is under review; final integration requires a current-main rebase and repeat of the canonical Git gate tests.

## Visual impact

No new visual component is required. Errors become more specific, and existing engine inspection data gains a channel
field. Headless assertions are sufficient; visual QA is opted out in `tasks.md`.

## Sources consulted

- `docs/specs/382-persistent-engine-shell-boundary/{spec,notes}.md` — immutable staging, upgrade/rollback and same-version reuse decision.
- `docs/specs/371-governed-release-boundary/spec.md` — honest local provenance boundary; no security overclaim.
- `esbuild.mjs`, `scripts/{package-clean-gate,prepare-package,record-provenance}.mjs` — current clean-build provenance path.
- `src/engine-service/{protocol,engineBundleStore,engineSupervisor,engineService}.ts` — current manifest and live transition contracts.
- `src/shell/WorkspaceClient.ts`, `src/extension.ts` — installed zero-step staging and VS Code mode boundary.
- `scripts/dev-host/{pointer.mjs,cli.sh}`, `.vscode/tasks.json`, `docs/runbooks/dev-host.md` — current F5/headless isolation lane.
