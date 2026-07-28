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
  is emitted, so the measured default remains off. Version drift is guarded as of
  `t-c46aad` — see the measurement below.
- **Lifecycle:** same home retains state across fresh/restart/resume; native fork
  is unavailable.
- **Classification:** native; disabled by measured default, but Tachyon control
  remains `declared`, not verified.

#### Behavioral measurement, 2026-07-28 (`t-c46aad`) {#codex-2026-07-28}

Run against Codex CLI 0.145.0 with `CODEX_HOME` pointed at a temporary directory. No model call was
made and no real `~/.codex` was read.

**Codex reports its own effective memory state, for free.** `codex features list` prints one row per
feature with stage and effective value, and at 0.145.0 it reads:

```
memories                             stable             false
```

Stable, and off. Three things follow at zero spend:

1. **The measured default is a fact with a version attached** rather than a claim inherited from a
   README — which is what the drift risk here actually needs.
2. **Both control paths move it, observably.** `codex --enable memories features list` flips the row
   to `true`, and so does `[features] memories = true` written into the private
   `CODEX_HOME/config.toml`. So Tachyon's control is checkable end to end without a turn: materialize
   the canonical config into a private home, ask Codex, read the answer back.
3. **`CODEX_HOME` is the boundary.** With it pointed at a temp dir, Codex resolved config from there
   and created its state (`config.toml`, `skills/`, `shell_snapshots/`, `installation_id`) there
   rather than in the real home.

**The near-miss.** `codex debug prompt-input` renders the model-visible prompt list as JSON with no
model call — apparently the injection oracle Claude Code never had. It is not. With a synthetic memory
planted in `<CODEX_HOME>/memories/`, the render was **byte-identical** with the feature off and on,
while `features list` proved the flag had genuinely flipped underneath. `prompt-input` renders the
static session context and is blind to memory.

That cuts both ways: the measurement that fails to prove injection also fails to disprove it. Memory
injection runs as an async pipeline on eligible threads, so `disable`, `enable`, `injection` and
`mutation` still need a live session, exactly as for Claude. They stay `declared`, canonical policy
stays `disabled`, and `runtime-managed` stays blocked.

What genuinely improves is `control.detect`, promoted `config` → `runtime-status`: Claude needed a
billable turn to say anything about memory state, Codex answers for free. That is a control
capability, recorded where it belongs instead of laundered into an evidence axis it cannot support.

**Drift guard.** This section previously ended "No behavioral assertion prevents version/default
drift." That was too strong, and the correction matters more than the addition:
`test/unit/agentProfileConfigLoader.test.ts` already asserted that an ambient **global** config
setting `memories = true` does not reach the projection. What was genuinely missing, and is now
covered by `test/unit/codexMemoryAdapter.test.ts`:

- **Version drift** — the real gap. `resolveMemoryPolicy` refuses to answer for any build other than
  0.145.0, so a release that flips the default cannot inherit this measurement's green.
- **The Control-editable surface** — `CODEX_EDITABLE_SETTING_KEYS` is a different door from the
  profile loader, and nothing asserted a memory key stays out of it.
- **The workspace source** — workspace keys run through the `selectedWorkspaceKeys` branch, which
  reports rather than silently ignores; the existing coverage was global-sourced only. The projection
  names `features.memories` as outside the allowlist while still projecting the legitimate sibling key
  beside it, so the guard means exclusion rather than breakage.

**Fork.** `codex fork` DOES exist at 0.145.0, so the lifecycle field invites the opposite conclusion
from a reading of `--help`. It forks a conversation, and memory is `CODEX_HOME`-global, so a forked
session inherits the same store rather than a copy. Fork is not a memory-isolation boundary;
`unavailable` stays correct, and `CODEX_FORK_NOTE` records why.
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
- **Controls:** the shipped guide claims `--no-memory` has absolute precedence.
  **Measurement refuted that** (`t-0e88f3`, below): `GROK_MEMORY=1` outranks the
  flag in headless mode. CLI, environment and TOML can enable it; native commands
  browse/edit/stats/clear memory.
- **Tachyon today:** wired canonical launches pin `GROK_MEMORY=0` in the spawn env
  (`t-0e88f3`) — the control Tachyon owns and the runtime was observed to honor.
  `--no-memory` is still emitted, as a documented no-op rather than a guarantee.
  Absence is not behaviorally proven.
- **Classification:** native; disable mechanism **refuted** as documented and
  re-implemented through the environment — not behaviorally verified in the new
  form.

#### Control change, 2026-07-28 (`t-c46c35`) {#grok-2026-07-28}

> **SUPERSEDED — the central claim of this section is false.** Everything below reasons from the
> shipped guide's precedence table, and a behavioral measurement the same day
> ([§ Refutation](#grok-2026-07-28-refuted)) contradicted it: `--no-memory` does **not** outrank
> `GROK_MEMORY=1` at 0.2.112. The section is kept unedited because the reasoning is the artifact — it
> is a worked example of a conclusion that was careful, well-sourced, internally consistent and wrong,
> and deleting it would remove the only evidence of how that happens. Read it as a record of what was
> believed, not as a description of the product.

Measured against Grok 0.2.112 (`grok --help`, `grok memory --help`, and the shipped user guide
`~/.grok/docs/user-guide/13-memory.md`). No model call, and no memory store read — only shipped
documentation and flag help.

This is the one runtime in the lane where the right move was to change the product rather than to
record a careful "not proven", because Grok exposes a control with **absolute precedence**. The
shipped guide states the order outright:

```
1. --no-memory CLI flag (always disables)
2. --experimental-memory CLI flag (enables)
3. GROK_MEMORY env var: 1/true enables, 0/false disables
4. [memory] section in config.toml
5. Default: disabled
```

Canonical Grok was relying on **rule 5**, while rules 3 and 4 sit above it and are writable by anyone
with an environment or a config file. Pinning rule 1 replaces "we inherit a default that happens to be
off" with "we state it, and nothing below can outrank us".

**Where the pin went, and the path that actually mattered.** The obvious targets were
`HarnessManager.materialize` and `materializeHomeOnly`, and both got it. But the common canonical Grok
agent is *non-harness with Bridge wiring*, which deliberately skips `isolate: transcript` (t-303f2b)
and therefore reaches neither materializer — it is wired in `AgentManager.withRuntimeBridge`, which
previously returned the command unchanged. Pinning only the two obvious paths would have left the
usual case untouched while every test looked green.

**Boundary, stated rather than hidden.** With the Bridge down there is no private home and no pin:
`withRuntimeBridge` returns before the grok branch, so the launch is untouched and the session inherits
the runtime's own disabled default — the pre-existing situation, unchanged. The pin covers the wired
canonical path, which is the one with a private home worth protecting.

**No evidence axis is promoted by this change.** Pinning a flag is a control improvement, not an
observation of behavior, and the value of this lane is that those two never get conflated. Grok
0.2.112's `memory` subcommand exposes only `clear` — no status or stats readout, so unlike Codex there
is nothing non-billable that reports effective memory state, and nothing renders what reaches the
model. The fresh/restart/resume/fork absence proof still needs an authorized session, and the case
worth running is the hostile one: `GROK_MEMORY=1` set in the environment and the planted marker still
not reaching the model. That is the drift the pin exists for, and proving it is what would let
`disable` move off `declared`.
- **Primary evidence:** installed
  `~/.grok/docs/user-guide/13-memory.md`, `grok --help`,
  `src/probe/adapters/grok.ts`, `src/harness/HarnessManager.ts`.

#### Refutation and re-implementation, 2026-07-28 (`t-0e88f3`) {#grok-2026-07-28-refuted}

Measured under human approval `a-b4b050`, Grok 0.2.112, effective model `grok-4.5-build`, in a private
`GROK_HOME` projected by the product's own `materializeBridgeMcpGrok`. **This is the first behavioral
measurement in the lane, and it refuted the thing the previous section had just shipped.**

**Two arms, one planted synthetic marker.**

| Arm | Launch | Result |
| --- | --- | --- |
| hostile | `--no-memory` **and** `GROK_MEMORY=1` | model answered with the **exact marker**; `MEMORY_INIT` (`watcher_config_enabled=true`), `MEMORY_INJECT_SEARCH results=1`, first-turn injection; store **written** during the run (`memory/repo-946b4ffe/index.sqlite`, 77,824 bytes) |
| default | clean env, no flag | no `MEMORY_INIT`, no `MEMORY_INJECT`, marker never reached the model, nothing written |

**The second arm is what makes this a finding rather than a puzzle,** and it cost two cents. Reading
the hostile arm alone cannot distinguish "the flag is inert" from "the env var outranks the flag" — in
both worlds memory runs. The default arm shows the default really is off, so memory became active
*because* `GROK_MEMORY` turned it on, which pins the failure on precedence specifically. A null result
needs a positive control or it is not a result.

**What was false, precisely.** Not the flag's existence and not its direction — `--no-memory` is a real
flag that really means disable. What was false is its **rank**: the guide places it above
`GROK_MEMORY`, and at 0.2.112 it is below. Everything `t-c46c35` built rested on that one row of that
one table, and nothing in the change was verifiable without spending money, which is exactly why it
shipped unverified.

**The impact was a false guarantee, not a live defect.** In the ordinary case the default is already
off, so canonical Grok agents were not running with memory active. What was wrong was the *claim* —
the module header, `GROK_MEMORY_PRECEDENCE`, the commit message and this document all asserted immunity
to a hostile environment. Anyone later reasoning "we are safe because we pin rule 1" would have been
wrong, and preventing that belief is the entire purpose of this lane.

**The fix moves the guarantee to a channel Tachyon owns.** Canonical launches now pin
`GROK_MEMORY=0` in the spawn env (`grokMemoryEnv`, wired at all three canonical sites:
`HarnessManager.materialize`, `HarnessManager.materializeHomeOnly`, and `AgentManager.withRuntimeBridge`
— the last being the common non-harness Bridge-wired agent, which reaches neither materializer). The
same measurement that refuted the flag is what recommends the variable: it was decisive enough to
overrule the flag, so setting it uses the control the runtime honors rather than the one it documents.

Two choices inside that fix are worth stating rather than leaving to be re-derived:

- **`0`, not removal.** Removing the variable returns the launch to rule 5, the bare default — the very
  position `t-c46c35` set out to improve on. It is also not expressible: the spawn env is a
  `Record<string, string>` delivered through `tmux new-session -e`, a channel that can set a variable
  but not unset one. `0` is an assertion in a channel Tachyon controls end to end; absence is an
  assumption about everyone else's environment.
- **The pin outranks the secret map.** In `materialize` the memory env is spread *after* `secretEnv`, so
  a user-configured `GROK_MEMORY` secret cannot re-enable memory on the canonical path. That ordering
  is pinned by test, because getting it backwards would reintroduce the hostile environment through
  Tachyon's own hands.
- **The probe adapter was the most exposed caller, not the least.** `src/probe/adapters/grok.ts` pinned
  `--no-memory` and ran `-p` — and headless is the exact mode the refutation was measured in. A probe
  inheriting a hostile environment would have had memory injecting into a measurement whose entire
  value is a bounded, reproducible surface. It now pins the env var too; `ProbeRunner` spreads
  `Invocation.env` over `process.env`, which is precisely where a hostile value would arrive.

The `--no-memory` flag is still emitted. It is free, it is the documented control, and measurement
showed it to be inert rather than harmful — it simply may no longer be described as immunity.

**Evidence vocabulary.** `disable` moved from `declared` to **`refuted`**, a value this task added to
`MemoryEvidence`. `declared` reads as "nobody checked", which is the opposite of what happened, so a
vocabulary without "tested and failed" downgrades its worst finding into an unmade one exactly when it
matters most. `refuted` is behavioral in the same sense `verified` is: neither may be authored from
documentation. A `refuted` axis must carry a `refutations` entry naming the claim, what was measured
instead, the version and date, and where the evidence lives — enforced at module load by
`assertRefutationsAreExplained`, because a verdict with no finding behind it is barely better than the
`declared` it replaced.

**The `disable` axis was NOT promoted for the new control.** The env pin is a control change, not an
observation; conflating the two is the mistake this section documents. It stays `refuted` until a
measurement of the *canonical env* passes with a working positive control.

- **Primary evidence:** `t-c46c35` journal `j-b02184d17f19` (arm output, debug log, store bytes);
  approvals `a-b4b050`, `a-c1a580`, `a-a3db98`; `src/runtime/adapters/grokMemory.ts`,
  `src/runtime/nativeMemory.ts`, `test/unit/grokMemoryAdapter.test.ts`,
  `test/unit/runtimeNativeMemory.test.ts`.

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
