# Agent-native configuration inheritance

**Status:** ratified architecture baseline  
**Task:** `t-5ca3dd`  
**Affected Product Invariants:** none — this records ownership and parity gaps; it does not change runtime behavior.

## Decision

A private runtime home and equivalent agent behavior are separate requirements.

Every canonical agent keeps a private operational home, but Tachyon may materialize selected native
configuration into that home. “Inheritance” never means sharing the global mutable home. It means
reading an approved source and producing a controlled, inspectable projection for that agent.

Existing legacy agents are not migrated. This contract applies to agents created canonically and to
future adapter work.

## Four planes

Every runtime-native input belongs to exactly one plane:

| Plane | Owner | Examples | Rule |
|---|---|---|---|
| Agent policy | human/Tachyon | model selection, approval posture, chosen hooks or skills | persistent, reviewable and independent of runtime file layout |
| Runtime projection | Tachyon | generated `config.toml`, `settings.json`, MCP blocks, copied skill snapshots | fully regenerable from policy plus approved source material |
| Runtime state | runtime | transcripts, caches, notices, session databases, runtime-written preferences | mutable; never treated as authored agent policy |
| External authority | host/provider | OAuth credentials, API keys, host trust/authority records | referenced or brokered; never serialized into the profile or exported |

Runtime-managed memory remains owned by `t-d4c42e`. Tachyon plugins remain owned by their plugin tasks.
Both still appear in parity when they influence effective runtime behavior.

## Policy vocabulary

Policy is capability-scoped, not one `inherit: true` switch. Each supported native configuration
family chooses:

- **source:** `global`, `workspace`, or `agent`;
- **treatment:** `exclude`, `snapshot`, `overlay`, or `external`;
- **refresh:** `create-once`, `every-launch`, or `runtime-owned`;
- **lifecycle:** whether the projection applies to fresh start, restart, resume and fork.

Meanings:

- `exclude`: the source cannot affect this agent;
- `snapshot`: copy approved bytes into the private home without a live link;
- `overlay`: merge approved fields into a Tachyon-generated runtime file;
- `external`: retain only a governed reference, normally for credentials or host authority.

Adapters expose only combinations they can implement and verify deterministically. Unsupported
combinations fail closed instead of silently degrading behavior.

## Required capability families

Each adapter must measure these families independently:

1. model, provider, reasoning and service tier;
2. approval, sandbox and trust posture;
3. UI preferences, status line and personality/instruction settings;
4. hooks, MCP, skills and runtime-native extensions/plugins;
5. feature flags;
6. authentication and external authority;
7. runtime-managed memory (reference `t-d4c42e`);
8. caches, notices and telemetry;
9. resume/fork consistency.

For each family, evidence must name the real source, projection target, mutable state, credential
involvement and behavior on fresh/restart/resume/fork. Unknown remains unknown.

## Current measured baseline

| Runtime | Current native-config behavior | Status |
|---|---|---|
| Claude | Private `CLAUDE_CONFIG_DIR`; workspace settings and skills are projected; workspace MCP is regenerated; ambient prompt/plugin roots are rejected; auth/bootstrap remains external; native memory is forced off. | Partial: selective behavior exists but is not an authored per-family policy. |
| Codex | Private `CODEX_HOME`; legacy home-only mode can copy global `config.toml`, while canonical projection removes it and currently requires workspace native config to be empty; auth remains external. | Gap: canonical agents cannot select which global/workspace behavior to preserve. |
| OpenCode | Private XDG config/data/state; harness can snapshot workspace `opencode.json` or start empty and overlay MCP. | Partial: coarse workspace/none switch, not capability-scoped policy. |
| Grok | Private `GROK_HOME`; Bridge config and trust are regenerated; auth is externally linked/reconciled; ambient config, memory and plugins are excluded. | Gap: no authored policy for native config families. |
| Pi | Private agent/session homes; safe JSON settings are seeded once with executable resources removed; declared resources are exact snapshots; auth is a private external-state copy. | Partial: strongest separation, but source/refresh choices are implicit adapter behavior. |
| Hermes | Private `HERMES_HOME`; global non-MCP `config.yaml` is seeded, workspace config may replace it, MCP is overlaid, OAuth/API-key files remain external and `state.db` is runtime-owned. | Gap: Hermes has operational inheritance but no canonical profile inspector or capability-scoped policy. |

The table records current code, not desired parity. Marks in `docs/runtimes/parity.md` stay `~` or
`✗` until each family has named evidence.

## Agent Studio

Agent Studio should present policy in plain groups, not expose raw runtime files:

- “Use my global defaults”, “Use workspace defaults”, or “Configure this agent” per supported family;
- a preview of what will be copied, merged, excluded or externally referenced;
- unsupported choices disabled with the adapter limitation;
- provenance showing source, last projection and whether restart/resume rematerializes it.

Secrets, caches, transcripts and raw runtime homes are never editable fields.

## Implementation boundaries

Implementation is split by adapter. A shared schema may define the vocabulary and provenance shape,
but each adapter owns parsing, allowlisting, materialization and lifecycle evidence. Plugin redesign,
runtime memory and migration of existing agents remain separate work.
