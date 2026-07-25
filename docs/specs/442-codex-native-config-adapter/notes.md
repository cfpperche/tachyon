# 442 — codex-native-config-adapter — notes

_Created 2026-07-23._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Slice A accepts exactly `selectors / agent / overlay / every-launch / fresh+restart+resume`.
  Lifecycle order is not semantic, but adding `fork` rejects the tuple.
- The resolved launch definition carries typed selector values, never raw TOML. The Codex materializer
  renders only `model`, `model_provider`, `model_reasoning_effort` and `service_tier`.
- Every materialization atomically replaces the private `config.toml`; authentication remains an
  external symlink created by the existing private-home boundary.
- The human ratified Slice B's closed allowlist: `approval_policy`, `sandbox_mode`, `personality`,
  `tui.status_line`, `tui.status_line_use_colors` and `features.terminal_resize_reflow`.
  Memory, auth/provider redirects, hooks/trust, telemetry/notify, notices and all other flags remain
  excluded.
- Global config is parsed and filtered because the private `CODEX_HOME` suppresses the ambient
  global file. Workspace config remains visible to Codex itself, so selecting a workspace family
  fails closed if `.codex/config.toml` contains any leaf outside the explicitly selected family
  allowlists.
- Missing selected keys stay absent in the generated file and therefore use Codex defaults; there
  is no cross-source fallback.
- TOML parsing uses `@iarna/toml`; `smol-toml` was rejected because its ESM-only package shape is
  incompatible with Tachyon's current CommonJS extension build.
- Slice C source matrix is closed to measured paths: global MCP declarations may be inventoried by
  name from `~/.codex/config.toml`; workspace MCP declarations by name from `.codex/config.toml`;
  workspace hooks from `.codex/hooks.json`; workspace skills from `.agents/skills/<name>/SKILL.md`.
  A selected profile item is never re-read from those paths: SDD 428 captures its pinned bytes with
  no-follow custody and uses that captured projection. Global skills have no measured projection
  path, so they are unavailable rather than copied. `hooks.state`, credentials, notices and all
  runtime-maintained data are excluded from inventory and projection.
- Codex plugins are a universal plugin-directory surface, not a measured per-agent extension loader.
  They remain workspace-owned and are reported as unavailable for profile composition; a later
  adapter measurement is required before changing that boundary.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- Existing SDD 428 capability references already persist a human-selected, captured composition for
  Codex skills, MCPs and hooks. Slice C must reuse that authority path instead of adding a second
  selection format. `t-2b258a` joins it with the native scalar materializer, so a canonical launch
  cannot discard capabilities when it also has native policy. Discovery by global/workspace/profile
  source and its Studio editor are separately tracked in `t-c9a086` and `t-115742`.
- The current Codex product documentation describes plugins as a universal plugin directory. That
  does not establish a safe per-agent native-extension projection, so extensions/plugins remain
  outside the generated private home pending the explicit measurement task.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Slice C contract: hooks, MCPs, skills and native extensions are runtime tooling that a human can
  compose per agent from global, workspace and agent sources. The profile persists enabled/disabled
  selections; the private harness receives only the effective composition; Agent Studio always
  shows the available source inventory and effective result. Tachyon does not add a policy engine
  that judges the human's risk choice. Plugins remain outside this slice.

## t-115742 — Studio tooling controls evidence (2026-07-25)

- Agent Studio projects only the IDs and owner scopes of host-authorized captured skills, MCPs and
  hooks. It never projects reference paths, captured bytes, commands, credentials, grant IDs or
  runtime trust state.
- A save is revisioned and the host independently checks the selected ID's reference kind and host
  grant. The returned profile capability object is explicitly reconstructed for the three Codex
  tooling families; Pi resources remain unchanged. New profiles cannot select a reference before
  host authorization exists.
- Focused proof: `npm run typecheck` and 125 Agent Studio/profile/workspace tests passed. An
  adversarial Claude probe found the risk in spreading the client capability object; the resulting
  patch now rejects unknown keys through the strict mutation schema and reconstructs only the three
  validated families.
- Installed evidence: the worktree-local Dev Host was armed against the `codex-tooling` fixture;
  `headless-interactive.mjs` booted the pointed extension successfully and wrote
  `.tachyon/evidence/t-115742-installed/result.json`. The canonical Agent Studio preview rendered
  the redacted runtime-tooling control at `.tachyon/evidence/t-115742-agent-tooling.png`.

## t-1a3d50 — lifecycle parity evidence (2026-07-25)

- `test/unit/agentManager.test.ts` now exercises the actual `AgentManager` launch boundaries, not
  only `HarnessManager`: fresh spawn, forced fresh restart and resume each invoke the canonical
  Codex materializer before launch.
- The fixture carries every shipped family in one projection: selectors; approval/sandbox;
  personality/status; terminal reflow; captured skill; MCP with a launch-only environment secret;
  SessionStart hook; and Bridge. It deliberately corrupts `config.toml` and the captured skill
  between cycles (content replacement, then file deletion), then proves all three generated TOML
  byte strings are identical and the captured skill is restored. The launch argv receives that same
  private `CODEX_HOME` on all three paths.
- The proof also keeps a real `auth.json` external via a private-home symlink, rejects both an
  ambient real-home config and workspace source config from generated output, and confirms that
  Codex fork reports its native unsupported state.
- Dev Host S1 headless smoke passed against this isolated worktree at `be3dc5d1` on 2026-07-25:
  `node scripts/dev-host/lane.mjs run --owner codex --target worktree -- npm run dogfood:dev-host -- headless`.
  Report: `/tmp/tachyon-dev-host/default/headless-out/result.json`; screenshot was copied to
  `.tachyon/evidence/dev-host/fail-visible.png`. This proves the built extension cold-starts under
  its private Dev Host namespace; the lifecycle equivalence claim remains grounded in the
  launch-boundary test above, not in this generic S1 fixture.
- The first SDD wrapper rerun exposed a Dev Host S1 race: its LKG only repeated names from the
  valid bootstrap config, so a late reload could choose a still-known live definition and report a
  permitted spawn. The fixture now carries an explicit `lkg-only` entry, making its refusal probe
  deterministic without changing product behavior.

## Verification log

### 2026-07-25T14:45:59Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/codexNativeConfigProjection.test.ts test/unit/agentNativeConfigPolicy.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts` — pass

## Dogfood log

### 2026-07-25T14:46:04Z — fail (0/1) — source: tasks.md — commit: be3dc5d103b457ab13f90009df7a0e74b8f095f2
- `node scripts/dev-host/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- npm run dogfood:dev-host -- headless` — fail

### 2026-07-25T14:47:31Z — pass (1/1) — source: tasks.md — commit: be3dc5d103b457ab13f90009df7a0e74b8f095f2
- `node scripts/dev-host/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- npm run dogfood:dev-host -- headless` — pass
