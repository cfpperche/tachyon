# Runtime-native memory parity and trust boundary

**Task:** `t-d4c42e`  
**Measured:** 2026-07-26  
**Installed versions:** Claude Code 2.1.220; Codex CLI 0.145.0; Grok
0.2.112; OpenCode 1.18.4; Pi 0.80.10; Hermes Agent 0.18.2.

## Decision

Runtime-native memory is persistent prompt-writing authority owned by a runtime
or runtime extension. It is not an ordinary native-config scalar and it is not
Tachyon's human-approved selected-memory lane.

One `unsupported | uncontrolled | controllable` enum is too lossy. Availability,
control evidence, injection, mutation, storage scope and lifecycle are
independent facts. In particular:

- writing a disable setting proves only that Tachyon authored bytes;
- a runtime can stop injecting memory while still writing or consolidating it;
- a private config home can isolate files while an external provider remains
  shared;
- repository identity can intentionally alias clones and worktrees;
- a plugin can inject persistent context even when the core runtime has no
  built-in memory feature.

Canonical profiles therefore default this lane to `disabled`. Tachyon may offer
`runtime-managed` only when the exact runtime/version has behaviorally verified
disable and enable controls, a bounded injection contract, explicit lifecycle
semantics and an isolated store or explicitly external provider boundary.
Unknown evidence fails closed.

## Proposed adapter contract

```ts
type MemoryEvidence = "unsupported" | "declared" | "verified";
type MemoryMechanism = "none" | "native" | "extension" | "external-provider";
type MemoryScope = "agent" | "repository" | "global" | "external" | "unknown";
type MemoryLifecycle = "retain" | "reset" | "copy" | "shared" | "unavailable" | "unknown";

interface RuntimeNativeMemoryCapabilityV1 {
  schemaVersion: 1;
  adapter: string;
  runtimeVersion: string;
  mechanism: MemoryMechanism;
  defaultState: "enabled" | "disabled" | "unknown";
  evidence: {
    inventory: MemoryEvidence;
    disable: MemoryEvidence;
    enable: MemoryEvidence;
    injection: MemoryEvidence;
    mutation: MemoryEvidence;
    isolation: MemoryEvidence;
  };
  control: {
    detect: "none" | "config" | "runtime-status";
    disable: "none" | "config" | "environment" | "argv";
    enable: "none" | "config" | "environment" | "argv";
    purge: "none" | "files" | "native-command" | "api";
    export: "none" | "files" | "native-command" | "api";
  };
  injection: {
    mode: "none" | "startup-bounded" | "every-turn" | "retrieval" | "mixed" | "unknown";
    bound?: { kind: "bytes" | "lines" | "characters" | "items"; value: number };
  };
  mutation: {
    modes: Array<"human-confirmed" | "agent-tool" | "background-extraction" | "external-provider">;
  };
  storage: {
    owner: "runtime" | "extension" | "external-provider" | "none";
    scope: MemoryScope;
    privateHomeBound: boolean | "unknown";
    aliasesWorktrees: boolean | "unknown";
  };
  lifecycle: Record<"fresh" | "restart" | "resume" | "fork", MemoryLifecycle>;
  sources: Array<{ kind: "installed-source" | "runtime-doc" | "behavioral-test"; ref: string }>;
}
```

**Implemented by `t-56daa1`** as `src/runtime/nativeMemory.ts` (the typed capability, the registry of
what was measured here, and `resolveMemoryPolicy` implementing § "Fail-closed product semantics" rule
by rule) plus `src/runtime/nativeMemoryVerifier.ts` (the behavioral harness below). The registry is
authored entirely at `declared`/`unsupported`, matching this document: as of the measurement Tachyon
had verified nothing behaviorally, so `resolveMemoryPolicy` today BLOCKS every runtime with native
memory. That is deliberate and not yet wired into canonical readiness — the per-runtime tasks
(`t-f22211`, `t-c46aad`, `t-c46c35`, `t-b5d28c`, `t-b4a557`) are what run the verifier against an
exact version and promote an axis.

An adapter must never report `verified` from configuration bytes alone. A
behavioral verification plants a synthetic marker in an isolated store, starts
the exact lifecycle operation, observes whether the marker reaches model input
or the memory store, and then proves cleanup. It must not inspect or mutate user
memory.

## Runtime inventory

### Claude Code 2.1.220

- **Mechanism/default:** native auto memory, enabled by default.
- **Producer/injection:** Claude writes `MEMORY.md` plus topic files. The first
  200 lines or 25 KiB of `MEMORY.md` are loaded at every new conversation;
  topic files are read on demand.
- **Storage/scope:** `<CLAUDE_CONFIG_DIR>/projects/<project>/memory/`, scoped by
  git repository and shared across its worktrees.
- **Controls:** `autoMemoryEnabled: false` or
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` declares no read/write. `/memory` exposes
  browsing and deletion.
- **Tachyon today:** canonical materialization forces
  `autoMemoryEnabled: false` in a distinct `CLAUDE_CONFIG_DIR`. Unit tests prove
  the projection, not runtime behavior. Fork creates a distinct private home
  and copies only the selected projection/transcript, not runtime memory.
- **Classification:** native; disable `declared`; enable/injection behavior not
  verified by Tachyon.
- **Primary evidence:** [Claude memory documentation](https://code.claude.com/docs/en/memory),
  [Claude environment variables](https://code.claude.com/docs/en/env-vars),
  `src/harness/HarnessManager.ts`,
  `test/unit/harness.test.ts`.

### Codex CLI 0.145.0

- **Mechanism/default:** native `memories` feature, stable but disabled in the
  measured installation.
- **Producer/injection:** eligible root sessions launch an asynchronous
  two-stage pipeline: DB-backed rollout extraction then global consolidation.
  It maintains raw memories and rollout summaries and injects memory usage/read
  instructions for eligible threads.
- **Storage/scope:** state DB and `<CODEX_HOME>/memories/`; effectively shared
  by every eligible thread using that `CODEX_HOME`.
- **Controls:** feature flag plus `[memories]` generation/use controls;
  app-server exposes experimental `memory/reset`.
- **Tachyon today:** canonical Codex gets a distinct private `CODEX_HOME`.
  Memory keys from ambient config are deliberately excluded and no memory flag
  is emitted, so the measured default remains off. No behavioral assertion
  prevents version/default drift.
- **Lifecycle:** same home retains state across fresh/restart/resume; native fork
  is unavailable.
- **Classification:** native; disabled by measured default, but Tachyon control
  remains `declared`, not verified.
- **Primary evidence:** [Codex memories pipeline](https://github.com/openai/codex/blob/main/codex-rs/core/src/memories/README.md),
  [Codex config schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json),
  [app-server memory reset](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
  `src/harness/HarnessManager.ts`,
  `test/unit/agentProfileConfigLoader.test.ts`.

### Grok 0.2.112

- **Mechanism/default:** native experimental memory, disabled by default.
- **Producer/injection:** manual confirmed notes, session-end metadata,
  LLM-generated flushes and automatic dream consolidation. It performs
  first-turn search injection and retrieval.
- **Storage/scope:** `$GROK_HOME/memory/MEMORY.md` plus a repository-identity
  workspace directory, session logs and SQLite index. Clones/worktrees of the
  same origin intentionally share the repository key inside one home.
- **Controls:** `--no-memory` has absolute precedence; CLI, environment and TOML
  can enable it; native commands browse/edit/stats/clear memory.
- **Tachyon today:** probes pin `--no-memory`; ordinary canonical launches do
  not. Their Bridge-only private `GROK_HOME` normally inherits the runtime's
  disabled default, but an ambient `GROK_MEMORY=1` or future default change is
  not overridden.
- **Classification:** native; disable mechanism declared and already used by
  probes, but not wired or behaviorally verified for canonical lifecycle.
- **Primary evidence:** installed
  `~/.grok/docs/user-guide/13-memory.md`, `grok --help`,
  `src/probe/adapters/grok.ts`, `src/harness/HarnessManager.ts`.

### OpenCode 1.18.4

- **Mechanism/default:** no built-in runtime-managed memory setting or command
  in the installed config schema/CLI.
- **Extension boundary:** plugins can mutate `system`, `messages` and tools
  immediately before model dispatch. A plugin can therefore implement memory,
  choose arbitrary storage or call an external provider.
- **Tachyon today:** private XDG config/data/state isolates core OpenCode state,
  but plugin behavior is not classified as native memory and may ignore XDG or
  use network state.
- **Classification:** built-in `unsupported`; extension memory `uncontrolled`
  until a plugin declares a separately verified capability contract.
- **Primary evidence:** [OpenCode plugin runtime hooks](https://opencode.ai/v2/docs/build/plugins),
  installed `opencode debug config`, `https://opencode.ai/config.json`,
  `src/harness/HarnessManager.ts`.

### Pi 0.80.10

- **Mechanism/default:** no built-in runtime-managed memory. Session persistence,
  compaction and branch summaries are conversation state, not cross-session
  learned memory.
- **Extension boundary:** Pi extensions can implement tools and storage, so an
  explicitly captured extension could add memory.
- **Tachyon today:** canonical Pi disables automatic discovery and loads only
  captured resources in a private home. This blocks ambient extension memory,
  but Tachyon does not understand the semantics of an authorized extension.
- **Classification:** built-in `unsupported`; extension memory `uncontrolled`
  unless separately declared and verified.
- **Primary evidence:** installed `pi --help`, [Pi settings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md),
  [Pi compaction](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md),
  `src/harness/HarnessManager.ts`.

### Hermes Agent 0.18.2

- **Mechanism/default:** built-in `MEMORY.md` and `USER.md`, plus one optional
  external provider. The installed user config enables built-in memory.
- **Producer/injection:** agent memory tool and review/nudge paths write bounded
  entries. A frozen, threat-scanned built-in snapshot and optional provider
  block enter the prompt; provider hooks can prefetch per turn and extract on
  session boundaries.
- **Storage/scope:** `$HERMES_HOME/memories/` for built-in state; provider scope
  and credentials are external.
- **Controls:** `memory.memory_enabled: false` disables built-in memory;
  `--ignore-rules`/safe mode skips memory together with other instruction
  sources. Native reset deletes `MEMORY.md`/`USER.md`; provider controls are
  separate.
- **Tachyon today:** a harness gets a private `HERMES_HOME` but copies the real
  non-MCP `config.yaml`, including memory/provider selection. It does not copy
  built-in memory files, so the store begins private and empty, while an
  external provider can still reconnect to shared state. Hermes lacks a
  canonical profile inspector/policy.
- **Classification:** built-in native and external-provider mechanisms;
  currently uncontrolled by canonical Tachyon policy.
- **Primary evidence:** installed
  `~/.hermes/hermes-agent/website/docs/user-guide/features/memory.md`,
  `tools/memory_tool.py`, `agent/agent_init.py`, `agent/system_prompt.py`,
  `src/harness/HarnessManager.ts`.

## Fail-closed product semantics

1. `prompt.memory.policy: disabled` requires `evidence.disable === "verified"`
   for a runtime/version that otherwise has native memory. Merely omitting an
   enable key is insufficient.
2. `runtime-managed` requires verified enable, injection, mutation and
   isolation evidence; complete lifecycle semantics; and a purge path.
3. `unsupported` is valid only for the built-in runtime. Loaded plugins or
   extensions remain a separate uncontrolled capability unless their exact
   digest declares this contract.
4. `uncontrolled` is visible and blocks a canonical `runtime-managed`
   selection. If the runtime defaults memory on and Tachyon cannot verify
   disable, canonical readiness is blocked rather than silently `Ready`.
5. Disabling does not delete bytes. Purge/forget is a distinct destructive
   operation requiring exact target preview and human confirmation.
6. Export contains selected runtime-owned text only when explicitly requested;
   raw transcripts, indexes, state DBs and provider credentials remain out.
7. Fresh/restart/resume/fork never infer copy semantics. Each operation uses the
   adapter's explicit lifecycle record.

## Required behavioral verifier

For each runtime with native memory:

1. create an isolated temporary runtime home and repository;
2. plant a unique synthetic marker only in that store;
3. run a non-billable inspection path when available, otherwise request
   explicit authorization for the smallest model call;
4. prove the marker is absent with memory disabled and present only within the
   declared bound when enabled;
5. prove whether writes occur after a controlled turn/session boundary;
6. repeat the required lifecycle operations;
7. delete the temporary home and record runtime version plus effective model.

The verifier must fail if effective model provenance is absent or differs from
the requested model. Probe `probe-42744006-bc41-426a-8047-4d8ad054c213`
demonstrated why: it was requested as Claude Opus 5 but executed Haiku 4.5 and
timed out, so its output was discarded.
