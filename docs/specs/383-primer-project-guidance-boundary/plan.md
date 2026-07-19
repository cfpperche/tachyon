# 383 — primer-project-guidance-boundary — plan

_Drafted from `spec.md` on 2026-07-14._

## Approach

Add an opt-in `settings.projectGuidance.files` config surface and a leaf loader/renderer that is independent of runtimes and Bridge internals. Parsing validates the closed shape and conservative POSIX-relative path syntax. Every injection reads all declared files from the canonical source workspace, validates containment/type/encoding/limits through file descriptors, and only then renders one provenance-labelled block. There is no implicit file name and no global cache.

Compose the project-owned block into the role/task body before `deliverableBody()`. The existing long-brief path therefore holds large guidance in `.tachyon/briefs/spawn/<agent>.md`, leaving only a pointer between the compact Tachyon primer and before-finishing block. Spawn and restart share `AgentManager.effectiveInstructions` on existing prompt-capable adapters; explicit self-managed/resume commands preserve their argv/transcript and unsupported startup adapters remain unchanged. Re-anchor uses the same project-guidance loader and brief diversion before any pane mutation. Resume stays unchanged.

Reduce `src/bridge/primer.ts` to protocol plus explicitly configured verification facts. Remove `freshWorktree` and all repository/package-manager/l10n/Git wording, remove the unavailable `orient` pointer, and render doorbell text only for a real target. Preserve the established Tachyon delimiters and gate facts. Finally, add a Tachyon-owned guidance document and opt this repository into it via `tachyon.yml`, update the public config contract, and amend spec 363 where its older repository-assumption wording is superseded.

## Primer line audit

| Current emitted content | Classification | Planned result |
|---|---|---|
| Primer/before-finishing delimiters | Universal Tachyon protocol | Keep |
| Agent identity and real parent/delegator | Universal Tachyon protocol | Keep |
| Gate behavior test, provided stub path, owns and identifier warning | Universal protocol populated by delegation facts | Keep the supplied facts; redesign of the still project-shaped stub generator is deferred to `t-2b8808` |
| `notify_agent` doorbell | Universal Tachyon protocol when a real target exists | Keep; omit invalid placeholder target |
| Long findings to artifact, continuity, approval confirmation | Universal Tachyon protocol | Keep |
| Task-contract/primer precedence | Universal Tachyon protocol | Rewrite to distinguish protocol from project guidance |
| Explicit `settings.verify.full/typecheck` | Project-derived configured fact | Keep, label workspace-config source; never invent a fallback |
| `npm test` fallback and unconditional full-verify cadence | Package-manager/repository policy | Remove from onboarding |
| Fresh-worktree `npm ci` and `node_modules/dist/.tachyon` claim | Tachyon repository policy and unreliable runtime fact | Remove; migrate bootstrap convention to project guidance |
| `Repo discipline` heading | Project policy container | Remove |
| Git pathspec/add/commit command shape | Repository workflow policy | Remove; migrate to Tachyon's project guidance |
| Commit message references task id | Conditional gate/workflow claim without a `taskId` input | Remove |
| `vscode.l10n` wording | Tachyon repository policy | Remove; migrate to Tachyon's project guidance |
| Deferred `orient` pointer | Universal product aspiration but unavailable command | Remove until the tool exists |
| Gate behavior test reminder at finish | Universal Tachyon protocol | Keep |

## Key decisions

- **Explicit file list only** — `settings.projectGuidance.files` is the sole opt-in; rejected default filenames and runtime context-file autodiscovery because they blur project ownership and recreate the runtime-convention matrix rejected by spec 363.
- **Source-workspace resolution** — paths resolve against the workspace that owns `tachyon.yml`, not an agent's delegated worktree or process cwd; this prevents a child from changing its own copied policy and prevents cross-workspace leakage.
- **Conservative bounded input** — allow at most 8 unique POSIX-relative file paths, each at most 256 UTF-8 bytes, and at most 64 KiB of guidance content in total. Reject absolute/drive/UNC paths, backslashes, controls, empty/`.`/`..` segments and trailing slashes. These bounds keep the config predictable while the brief-file path handles non-trivial documents safely.
- **Descriptor-based, all-or-nothing reads** — canonical containment, no-follow leaf opens, regular-file checks, bounded reads, strict UTF-8 and NUL rejection happen for every file before rendering. Rejected best-effort omission because a configured policy silently disappearing is more dangerous than a visible launch error.
- **No shared cache** — read at each spawn/restart/re-anchor so changes are current and workspace ownership is structural.
- **Separate renderer and delimiters** — project content never enters the global primer renderer; provenance markers surround but do not rewrite the file content.
- **Project content before brief diversion** — the combined project body passes through `deliverableBody()` before primer framing, preventing the 4 KB body from bypassing the measured tmux safety mechanism. Re-anchor uses its own brief purpose/path so a long re-anchor never overwrites the durable startup brief (called “spawn contract” when this historical plan shipped; terminology superseded by SDD 411).
- **Protocol precedence is explicit** — system/user authority and the active task contract remain authoritative for their scopes; Tachyon's primer owns orchestration protocol; project guidance owns repository conventions and cannot override protocol.
- **Configured verification is an explicit project fact** — exact configured commands are shown with workspace-config provenance and may be repeated as an action reminder, but the primer adds no invented fallback, `always/full` cadence, or tree-clean policy.
- **No-spawner means no doorbell target** — rejected the literal `<your spawner>` placeholder because it produces an invalid tool call.

## Files touched

- `src/config/projectGuidance.ts` — new path validator, safe reader and project-block renderer.
- `src/config/loadConfig.ts` — typed `settings.projectGuidance` parsing and validation.
- `src/config/tachyon.schema.json` — published closed-object schema.
- `src/bridge/primer.ts` — protocol-only renderer and configured-verify provenance.
- `src/agents/AgentManager.ts` — source-workspace load, body composition and pre-tmux failure ordering for spawn/restart.
- `src/agents/briefFile.ts` — purpose-specific long-brief paths so re-anchor cannot overwrite a startup brief.
- `src/resume/adapters.ts` — align `env` option-operand runtime detection so wrapped self-managed commands remain transcript-only.
- `src/workspace/Workspace.ts` — shared project-guidance composition for re-anchor before pane mutation.
- `src/bridge/approvalRequest.ts` — remove the stale comment that treated a primer policy as l10n authority.
- `docs/project-guidance.md` — Tachyon repository's own agent-facing bootstrap/Git/localization conventions.
- `tachyon.yml` — opt this repository into its project-owned document.
- `README.md` — config example, semantics, precedence, validation and failure behavior.
- `docs/specs/363-agent-onboarding/spec.md` — mark repository-specific primer wording as superseded by spec 383 while preserving Tachyon-owned push/pull architecture.
- `scripts/dogfood-project-guidance.mts` — independent headless self-host exercise of parsing, workspace isolation, refresh, provenance and protocol-only fallback.
- `test/unit/projectGuidance.test.ts` — path/security/rendering/limits/isolation tests.
- `test/unit/config.test.ts` and `test/unit/configSchema.test.ts` — parser and shipped-schema contract.
- `test/unit/primer.test.ts` and generated primer regression tests — line audit and configured-fact behavior.
- `test/unit/agentManager.test.ts`, `test/unit/briefFile.test.ts`, `test/unit/resume.test.ts` plus focused workspace tests — injection ordering, purpose-specific long briefs, wrapper/self-managed behavior, bare-agent, re-anchor and no-leak behavior.

## Risks & unknowns

- `tachyon.yml` has unrelated maintainer edits in the primary worktree. This isolated branch changes only the minimal project-guidance setting; integration must preserve the primary worktree version rather than overwrite it.
- Restart may currently tear down a session before composing the replacement command. Audit and, if necessary, reorder it so an invalid guidance file cannot destroy a running agent.
- `composeCommand` does not deliver prompts for every recognized AI CLI. This spec guarantees the boundary for existing prompt-capable adapters and records wider adapter coverage as a non-goal.
- The published settings schema already omits some parser-supported fields. Add the new field without broad unrelated schema repair; keep the test targeted to this contract.
- Guidance is trusted as project-authored prompt context, not as safe executable input. Clear provenance and protocol precedence mitigate confusion; enforcement remains in existing gates.

## Visual impact

No graphical UI changes. Agents see a new text block only in projects that explicitly opt in; snapshot/string tests are the appropriate proof.

## Sources consulted

- `docs/specs/363-agent-onboarding/spec.md` — Tachyon-owned onboarding channel and resume amendment.
- `src/bridge/primer.ts`, `src/agents/AgentManager.ts`, `src/workspace/Workspace.ts` — current render and injection paths.
- `src/agents/briefFile.ts` — 4 KB diversion and 12 KB inline safety ceiling.
- `src/plugins/paths.ts`, `src/plugins/dataLauncher.ts`, `src/worktree/evidenceArtifacts.ts` — path and descriptor safety precedents.
- `scripts/runtime-observability-reference.mjs` — canonical containment precedent.
- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json`, `test/unit/config.test.ts` — settings contract.
