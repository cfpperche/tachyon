# 406 — pi-harness-resources — plan

_Drafted from `spec.md` on 2026-07-18. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Extend the existing `agents.<name>.harness` contract with Pi-specific `extensions`, `prompts`, `themes` and `packages` path lists while reusing `skills`. Pi accepts only those resource capabilities: MCP, hooks, Claude rules and Codex instructions remain unsupported. Every source is workspace-relative and the parser rejects native Pi resource flags that would create a second authority. Pi resource harnesses reject `inherit:none`: the mode is an exact declared catalog rather than a claim that Tachyon can preserve selected automatic discovery.
2. Keep Pi outside the generic MCP-oriented `ResumeAdapter.harness` shape. In Workspace's existing lifecycle materialization seam, route Pi with a resource harness to a dedicated `HarnessManager.materializePiHome(agent, def)` path; route Pi without one through the current private-home-only path. The immutable Tachyon Bridge extension remains a separate additive injection and is never copied from project input.
3. First materialize/validate the SDD 401 private home and safe JSON/auth snapshots. Then prewalk every declared resource without following symlinks: extensions are `.ts`/`.js` files or directories with an `index` entry, skills are directories containing `SKILL.md`, prompts are `.md` files, themes are readable JSON-object files, and packages are local directories with a readable `package.json` or conventional Pi resource directory. Reject missing/special/symlinked/escaping trees and duplicate destination basenames before publishing anything.
4. Copy the complete validated inputs into staging under a Tachyon-owned private subtree, hash the validated copy, then publish/reuse a content-addressed generation (for example `<home>/.tachyon-resources/generation-<digest>/...`). Do not use Pi's global `npm/` or `git/` stores and do not invoke package managers. Local package dependencies must already be present as regular files in the declared package tree.
5. Return Pi-native CLI args that disable automatic discovery (`--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`) and explicitly add each private extension, skill, prompt and theme path. Pass each copied package directory through local `--extension`; Pi's shipped package resolver expands that local package into all four CLI resource sets even when automatic discovery is disabled, without installing it. Quote every private path for the shell.
6. Make a generation visible only after its full copy validates. Spawn/restart/resume use only the returned generation paths, so abandoned staging is never active and stale resources disappear from argv without mutating `settings.json`. Content-identical restarts reuse the same generation. Published generations remain inert but on disk for the private home's lifetime: fallible restart preparation must never delete files referenced by the unchanged live pane. Canonical agent forget removes the complete private home and every generation.
7. Update config/schema diagnostics and runtime documentation. Add focused parser/materializer/lifecycle tests and a real-Pi RPC dogfood fixture that proves declared extension, skill, prompt, theme and local-package discovery, sibling separation, stale removal and ambient Pi-home/`~/.agents`/project resource non-inheritance in exact mode.

## Key decisions

- **Reuse `harness:` rather than add a Pi-only top-level key** — SDD 401 explicitly deferred these as Pi harness capabilities, and users already understand harness as per-agent private configuration; rejected `piResources:` because it would duplicate lifecycle, schema and cleanup concepts.
- **Use a dedicated Pi materializer, not a fake MCP harness adapter** — Pi has no MCP client and its Bridge is an immutable extension; rejected adding a misleading `ResumeAdapter.harness` shape that would route through MCP file generation.
- **Snapshot workspace-local resources into the private home** — this gives each agent a stable, inspectable set and lets stale declarations be removed; rejected direct references because they can change underneath a running materialization and weaken sibling/home ownership.
- **Support local package directories only in this slice** — local paths require no fetch/install and can be reviewed with the repository; rejected npm/git specs because launch-time network, postinstall execution, mutable refs, consent and pin verification require a separate governed acquisition lifecycle.
- **Use exact CLI loading, not private settings mutation** — Pi's four `--no-*` flags suppress ambient `$HOME/.agents` and project auto-discovery, while explicit CLI paths remain additive; copied local packages ride through `--extension`, whose local resolver expands package resources without an install. Rejected settings projection because it cannot block `$HOME/.agents/skills` and collides with SDD 401's preserve-after-seed rule.
- **Content-address the owned resource subtree and bind argv to one complete generation** — identical restarts reuse one generation and changed catalogs publish another only after validation. Published generations are retained until canonical private-home cleanup because restart preparation is fallible and must not prune resources used by the unchanged live process; rejected mtime pruning and destructive in-place rebuild.
- **Keep trust data untouched but make harness resource loading exact** — ordinary Pi agents retain native project discovery; a Pi resource harness disables automatic project extension/skill/prompt/theme discovery instead of auto-trusting or trying to selectively mirror it.
- **Reserve a dedicated Tachyon subtree** — canonical private-home cleanup removes that internal subtree and never edits resource keys in private `settings.json`; rejected a settings ownership marker because no settings projection is needed.

## Files touched

- `src/config/loadConfig.ts` — extend `HarnessDef`, Pi capability validation, path-list parsing and native-resource flag conflict checks.
- `src/config/tachyon.schema.json` — expose Pi harness support and autocomplete descriptions for extensions/prompts/themes/local packages.
- `src/harness/HarnessManager.ts` — safe resource prewalk/copy, generation publication, exact Pi CLI args and stale cleanup.
- `src/workspace/Workspace.ts` — route Pi harness declarations through the dedicated materializer and update localized diagnostics if needed.
- `src/agents/AgentManager.ts` — keep the immutable Pi Bridge extension additive for Pi resource harnesses across spawn/restart/resume; existing harness Fork remains fail-closed.
- `test/unit/config.test.ts` — accepted Pi shapes plus unsupported capability, path and argv conflict failures.
- `test/unit/harness.test.ts` — all resource types, permissions, sibling separation, no-follow failures, atomic/stale cleanup and settings preservation.
- `test/unit/agentManager.test.ts` or `test/unit/workspaceHarness.test.ts` — prove spawn/restart/resume reuse the Pi resource materialization seam without disturbing Bridge/private-session wiring.
- `scripts/dogfood/pi-harness-resources.mjs` — real Pi RPC discovery and isolation proof with local temporary fixtures.
- `docs/runtimes/pi.md`, `docs/runtimes/parity.md` — promote opt-in Pi harness resources with exact limits and evidence.
- `docs/specs/406-pi-harness-resources/{spec,plan,tasks,notes}.md` — contract, implementation record and verification proof.

## Risks & unknowns

- Pi resources are executable/instruction-bearing and have the local user's permissions. The explicit `tachyon.yml` allowlist controls provenance and sibling inheritance; it is not a sandbox, content approval system or safety review.
- A local package with dependencies is usable only if its declared tree already contains those dependencies. Dogfood must prove the no-install path and docs must not imply Tachyon resolves dependencies.
- Exact `--no-*` posture disables automatic trusted project resources for the four managed classes while a harness is active. Docs must make that deliberate difference from ordinary Pi explicit.
- Crash safety spans staging and content-addressed resource directories. Bind argv only to a fully validated generation, clean only never-published staging entries during preparation, and retain published generations until canonical home cleanup.
- Existing generic skill materialization is less strict than the new Pi path. Avoid silently changing other runtimes' semantics in this SDD.

## Visual impact

No Tachyon UI layout changes. The visible effect is Pi's native startup/resource commands and optional theme. Real-Pi dogfood records command/theme discovery; no separate web/VS Code visual QA is useful.

## Sources consulted

- `docs/specs/399-pi-runtime-onboarding` through `405-pi-native-fork`, especially SDD 401's default-deny boundary.
- `docs/runtimes/pi.md` and `docs/runtimes/parity.md`.
- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json`, `src/harness/HarnessManager.ts`, `src/workspace/Workspace.ts`, `src/resume/adapters.ts`, and focused harness/config/agent tests.
- Installed Pi v0.80.10 `README.md`; `docs/settings.md`, `packages.md`, `extensions.md`, `skills.md`, `prompt-templates.md`, `themes.md`, `security.md`; shipped resource/package/settings loader code.
