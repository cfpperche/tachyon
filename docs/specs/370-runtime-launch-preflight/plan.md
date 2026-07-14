# 370 — Runtime launch preflight — plan

_Drafted 2026-07-10. No implementation before maintainer ratifies `spec.md` policy questions._

## Approach

Introduce a two-layer launch-readiness contract at the common `AgentManager` lifecycle boundary:

1. **Preflight before process creation** validates binary availability, command model selection, and any safe
   runtime-native capability source.
2. **Provisional startup after tmux creation** observes a bounded readiness/error window for failures that only the
   runtime process can reveal. A process is not reported as ready merely because tmux exists.

### Runtime launch adapter

Add a `RuntimeLaunchPreflightPort` selected by `runtimeOf(cmd)`. It receives a parsed command and a bounded effective
environment description, and returns a closed result:

```ts
type RuntimeLaunchPreflight =
  | { state: "supported"; runtime: string; model?: string; source: string }
  | { state: "unsupported"; code: "runtime_model_unavailable"; model: string; suggestions: string[] }
  | { state: "unverifiable"; reason: string }
  | { state: "failed"; code: "runtime_preflight_failed"; reason: string };
```

The port never returns raw stdout/stderr. Command parsing must be token-aware and non-executing; ambiguous shell
composition becomes `unverifiable`, not a guessed model.

### Codex adapter v1

For an explicit `-m/--model`, execute the exact prospective Codex binary's `debug models` under the relevant auth and
config/profile environment with a short timeout and total stream byte cap. Validate `{models:[...]}` incrementally and
retain only bounded `slug` values whose runtime catalog marks them selectable; never buffer or parse the complete raw
catalog. Independently bound JSON depth, retained token fragments, selectable-slug count, and slug length. Do not use
`supported_in_api`: the failing launch used ChatGPT account auth, and API support is a different property.

The current authenticated catalog empirically lists `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; it does not
list `gpt-5.6`. This catalog is runtime data, never committed product data. A missing exact slug rejects with at most
three deterministic close matches. Default-model launches need no model-membership check, but still receive binary
and provisional-startup validation.

### Lifecycle transaction

Refactor `spawnCore` preparation into an explicit sequence:

1. resolve definition/runtime/command and max-agent policy;
2. resolve or prepare cwd/worktree and materialized runtime environment;
3. run authoritative preflight before tmux;
4. on rejection, compensate any newly created worktree/reservation and persist nothing;
5. create tmux in provisional state;
6. observe runtime-specific readiness or classified startup failure for a bounded window;
7. only after ready/pending policy is satisfied, persist ledger, delegation, lineage, Bridge binding, and `onSpawned`;
8. on immediate rejection, kill tmux, compensate launch artifacts, and return a structured error.

Prefer moving reversible worktree creation after model preflight where the effective auth environment permits it. If
private-home materialization is required first, make cleanup an explicit transaction dependency rather than leaving an
orphan.

All lifecycle entry points—declared spawn/autostart, ad-hoc spawn, restart, resume, and fork—must call the same
preflight service. Presentation-only label inference in `runtimeProfile.ts` is not validation.

### Readiness classification

Reuse normalized attention/runtime-error patterns where sound, but keep startup classification separate from ordinary
turn errors. A runtime adapter can recognize composer-ready markers, structured startup events, clean interactive
readiness, and bounded fatal classes such as invalid model, auth rejected, invalid config, or missing binary. Timeout
means `pending/unknown`, not automatically failed. For ad-hoc delegation, the recommended contract is that
`spawn_agent` waits briefly and returns `ready` or `starting`; callers must not assign Tasks to `starting` agents until
readiness is later observed.

### Provisional bootstrap input

Keep `isReady()` as the sole promotion boundary and keep Task assignment plus `notify_agent` fail-closed. Add a
Codex-owned bootstrap classifier that inspects only a bounded tail of the current pane and recognizes the measured
terminal warning, update notice, directory-trust selector, and hook-review screens. Each screen exposes a closed answer
and delivery grammar. `write_input` may carry one of those answers only with `answering=true`; line prompts require
submit, while hook screens admit only the measured one-byte trust or Escape gestures with `submit=false`. All other
not-ready input retains `refused-not-ready`. The exception returns a distinct receipt and never marks the runtime ready.

Do not reuse the broad attention prompt manifest for authorization: it intentionally detects passwords, generic
questions, and arbitrary extra patterns, while this boundary carries input before the runtime is assignable and the
Bridge token does not prove the self-declared caller identity.

### EDH launch isolation

Make executable discovery deterministic and fail-closed. Prefer an explicit compatible executable, then the current
worktree's `.vscode-test` cache, then the primary checkout cache derived from Git's common directory. Reject a resolved
WSL `remote-cli/code` rather than launching a window that silently ignores extension-development isolation flags.

Launch both GUI and headless EDH children with `--use-inmemory-secretstorage`. Build the child environment explicitly:
remove inherited Tachyon Bridge identity, Codex session identity, Electron-as-Node, and parent tmux variables; add only
the fixture-private tmux/cache paths and the declared headless evidence variables. Parent process state is unchanged.

Native desktop Extension Hosts expose the Electron application as `process.execPath`, not a standalone Node binary.
When that path launches the persistent Bridge daemon, explicitly enable Electron's Node mode for both Linux
`systemd-run` and detached non-Linux children. EDH fixture cleanup first validates the descriptor's canonical workspace
identity, refuses a recorded live EDH, sends a bounded `stop` over the real control socket, terminates only the
fixture-private tmux server, and only then removes the fixture. It refuses malformed, oversized, or symlinked metadata
rather than risking an unrelated process or service.

## Key decisions

- **Dynamic runtime-native discovery, not static catalogs** — reconciles this fix with spec 328's decision not to own
  provider model ids.
- **Exact model semantics** — no silent fallback; similarity is suggestion-only.
- **Common lifecycle chokepoint** — Bridge-only validation is rejected because restart/resume/autostart would bypass it.
- **Catalog failure is not support** — explicit-model delegation fails closed when its authoritative probe breaks.
- **Readiness differs from process existence** — tmux creation is necessary but insufficient for successful launch.
- **Bounded allowlisted diagnostics** — raw Codex catalogs include large model metadata/base instructions and must not
  flow into user-visible or durable state.

## Candidate files

- `src/runtime/launchPreflight.ts` — neutral result types, command-model extraction, adapter registry, bounds.
- `src/runtime/adapters/codexLaunchPreflight.ts` — `codex debug models` probe and safe projection.
- `src/runtime/adapters/codexCatalogStream.ts` — bounded streaming JSON validation and selectable-slug projection.
- `src/runtime/adapters/codexLaunchReadiness.ts` — readiness plus prompt-specific provisional bootstrap classification.
- `src/agents/AgentManager.ts` — common lifecycle orchestration, provisional state, compensation, persistence ordering.
- `src/bridge/tools.ts` — structured spawn outcome/error only; no provider logic.
- `scripts/edh-palliative/resolve-code.mjs`, `scripts/edh-palliative/edh-palliative.sh` — compatible binary resolution and
  sanitized EDH child launch.
- `scripts/edh-palliative/stop-bridge.mjs`, `src/bridge/PersistentBridgeService.ts` — identity-scoped fixture cleanup and
  Electron-as-Node persistent daemon launch.
- `src/tasks/TaskStore.ts` or assignment boundary — only if ratification chooses assignment rejection for non-ready agents.
- `src/attention/*` — narrowly shared startup classifications if existing normalized patterns are reusable.
- `test/unit/runtimeLaunchPreflight.test.ts`, `test/unit/agentManager.test.ts`, `test/unit/bridge.test.ts` — exact catalog,
  malformed/timeout, no-side-effect rejection, lifecycle parity, readiness, and compensation.

## Risks

- Catalog commands may change between CLI versions. Adapter capability checks must be versioned and fail honestly.
- The effective private config home is materialized late today; moving probes earlier can accidentally test the wrong
  auth/profile, while moving them later can leak worktrees on failure.
- Shell command strings can contain quoting/wrappers. Reusing a whitespace split would misparse valid commands and can
  create false confidence.
- Readiness waits can slow spawn or classify slow startup incorrectly. Timeout must remain `pending`, not failure.
- Some runtime errors appear inside a still-running TUI, as in the screenshot. Exit-code-only detection is insufficient.
- A permissive pre-ready input exception would undo t-f87651 and could make a bootstrap trust choice an authorization
  bypass. Prompt recognition and admitted answers therefore remain runtime-specific and closed.
- Codex can truncate the right side of its status footer in a narrow pane before `Context %` appears. Readiness accepts
  the measured left-side model/effort/cwd structure, still paired with the current prompt glyph.
- Model catalogs can be account/entitlement specific and change without CLI version changes; avoid long-lived global
  caches. A short cache must include effective auth/config identity without storing secrets.

## Visual impact

No new primary surface. Failed spawn should produce a concise structured error and never create a misleading live
agent row. If a provisional `starting` state ships, sidebar and task-assignee affordances require visual proof.

## Sources consulted

- Screenshot and live failure: `gpt-5.6` rejected under Codex ChatGPT account after tmux creation.
- `codex-cli 0.144.1`: `codex debug models` is available and the authenticated catalog exposes exact selectable slugs.
- `src/bridge/tools.ts` `spawn_agent` — contract gate calls `AgentManager.spawn` and returns success immediately.
- `src/agents/AgentManager.ts` `spawnCore` — tmux is created before ledger/lineage, but no runtime readiness/model check.
- `src/runtime/runtimeProfile.ts` — model aliases/defaults are explicitly presentation fallbacks, not introspection.
- `docs/specs/328-handoff-assisted-distill/{plan,notes}.md` — prior decision against static provider catalogs and prior
  dogfood evidence that dated concrete model names fail.
