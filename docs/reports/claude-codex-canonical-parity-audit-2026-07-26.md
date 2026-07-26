# Claude ↔ Codex canonical parity audit — 2026-07-26

## Verdict

Claude and Codex have equivalent Tachyon product outcomes for canonical profile
authoring, controlled native-config projection, private-home lifecycle, external
authentication, Bridge/capability preservation, and measured Runtime Config
inspection/editing.

The parity is capability parity, not protocol symmetry:

- Claude supports a native session fork into a distinct private home.
- Codex does not support native fork and Agent Studio reports that profile as
  `Limited`; it does not synthesize a fork.
- Claude admits only its closed effort values and does not expose
  provider/service tier authoring. Codex exposes its measured selector fields.
- Runtime Config edits only the measured safe subset of each runtime's native
  source. Opaque executable payloads and credentials are never returned.

No contradictory product defect was found during this audit.

## Evidence map

| Claim | Direct evidence | Result |
|---|---|---|
| Agent Form creates and reopens both profiles | `scripts/dev-host/scenarios/claude-codex-parity-audit.mjs`; headless Dev Host result with 10 assertions | Pass. Claude reopened `Ready`; Codex reopened `Limited` solely for its named native-fork limitation. |
| Runtime-specific fields are honest | Same Dev Host scenario; `test/unit/agentProfileStudio.test.ts` (“accepts exact Claude authoring…”, “round-trips authored native policy…”) | Pass. Claude uses a closed effort selector and hides provider/service tier; Codex retains model, effort, provider and service tier. |
| Runtime Config inventory is content-safe and runtime-scoped | `test/unit/codexRuntimeConfigInventory.test.ts` (“reports only measured scalar values…”); `test/unit/claudeRuntimeConfigInventory.test.ts` (“returns measured scalars…without executable payloads”) | Pass. Each snapshot filters `potentialAgents` and `pendingAgents` to its own runtime. |
| Global/workspace writes preserve unrelated state | Codex test “patches one measured scalar while preserving unrelated TOML and MCP blocks”; Claude test “atomically changes one measured scalar while preserving unknown and opaque JSON values” | Pass. |
| Concurrent/stale edits fail closed | Both inventory suites' stale-revision tests; Claude additionally covers malformed JSON, symlinks and unsupported fields | Pass. |
| Fresh/restart/resume rematerialize equivalent policy | `test/unit/agentManager.test.ts`: “canonical Claude regenerates selected settings…”, “canonical Codex regenerates one private policy…” | Pass. Stale native state is removed before each launch operation. |
| Fork behavior is truthful | `test/unit/agentManager.test.ts`: “canonical Claude fork rematerializes projections…”, worktree-fork companion test, and “planFork: refuses a non-forkable runtime” | Pass. Claude gets a new home/cwd namespace; Codex refuses before mutation. |
| Private homes do not alias | Claude fork tests plus Codex “same-cwd codex agents use distinct private homes” | Pass. |
| Authentication stays external | `test/unit/harness.test.ts`: Claude and Codex harness auth-symlink tests, plus “rematerialize replaces a stale auth symlink” | Pass. Credentials are not profile-authored or copied into the durable profile. |
| Bridge and captured capabilities survive rematerialization | `test/unit/harness.test.ts`: “canonical Claude consumes captured capabilities, reserves Bridge…”, Codex private-config/typed-rewrite tests; lifecycle tests inspect regenerated Bridge/config state | Pass. |
| Invalid or ambient policy cannot widen authority | `test/unit/agentProfileConfigLoader.test.ts`: unsupported policy, unapproved Codex key, missing selector policy, Claude ambient/unmeasured selector and bypass rejection tests | Pass. |

## Executed checks

Focused comparative suite:

```text
Test Files  6 passed (6)
Tests       545 passed (545)
```

Command:

```sh
npx vitest run test/unit/agentProfileStudio.test.ts \
  test/unit/agentProfileConfigLoader.test.ts \
  test/unit/codexRuntimeConfigInventory.test.ts \
  test/unit/claudeRuntimeConfigInventory.test.ts \
  test/unit/harness.test.ts \
  test/unit/agentManager.test.ts --reporter=dot
```

Headless Dev Host:

```sh
node scripts/dev-host/headless-interactive.mjs \
  --scenario scripts/dev-host/scenarios/claude-codex-parity-audit.mjs \
  --timeout 180
```

The successful run created and reopened `parity-audit-claude` and
`parity-audit-codex`, inspected their persisted canonical YAML, and passed every
assertion. The captured view showed the Codex native-policy provenance and its
single explicit fork limitation without clipping or contradictory readiness.

## Scope boundary

Runtime-managed native memory is not silently counted as complete parity here.
It remains a separate multi-runtime trust-boundary investigation under
`t-d4c42e`. Runtime Config adapters for Grok, OpenCode, Pi and Hermes are also
separate roadmap slices.
