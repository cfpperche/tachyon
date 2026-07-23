# Runtime-native input inventory — installed profile adapters

_Observed 2026-07-23. This inventory belongs to SDD 439 / `t-7e7464`._

## Boundary

The profile resolver accepts a runtime adapter only when its host-selected inspector is versioned,
bound to the active profile authority revision and exhaustive. Every observed native source must be
suppressed or isolated before launch. Authentication and session/history files may remain runtime-owned,
but they cannot select model, prompt, permissions or capabilities.

The installed versions measured here are:

- Claude Code `2.1.218`;
- Grok `0.2.103` (`89c3d36fb6`, stable).

No secret values or runtime-history contents were read for this inventory.

## Grok

### Current effective launch

Every managed non-harness Grok agent already receives a private
`.tachyon/bridge-mcp/<agent>.grok` as `GROK_HOME`. Tachyon:

- symlinks only `auth.json` from the real `~/.grok`;
- rewrites private `config.toml` with the Bridge MCP entry;
- writes private `trusted_folders.toml` for the workspace and effective cwd;
- stores sessions, logs, memory/cache state and hooks under the private home;
- never copies the user's real `~/.grok/config.toml`.

The real home currently contains model/UI defaults in `config.toml`, but they are already excluded by
the redirected `GROK_HOME`. Auth remains an external secret lane.

### Forming/governing inputs to bind

| Input | Source | V1 canonical treatment |
|---|---|---|
| executable, model, reasoning | profile runtime selectors / CLI | generate or refuse unknown flags |
| provider/auth | private `auth.json` symlink | external secret/auth; cannot select profile fields |
| MCP | generated private `config.toml` | rewrite from captured profile/shared assignments + Bridge |
| cwd/trust | effective cwd + private `trusted_folders.toml` | generate exact workspace/cwd trust set |
| rules/system prompt/tools/permissions/sandbox | profile/runtime launch args | generate from closed fields or reject |
| hooks/skills | private generated home | materialize only captured assignments |
| memory | private runtime state / `--experimental-memory` | disabled unless the dedicated memory policy authorizes it |
| sessions/history/cache/logs | private home | excluded runtime-owned state |
| plugins/marketplace | workspace plugin subsystem | unchanged external subsystem; no profile ownership |

### Required oracle

The adapter must fail on executable mismatch, undeclared command flags, divergent generated config,
unexpected forming files or trust outside the exact workspace/effective cwd set. `grok-x` proves the
external cwd `/home/goat/monetizacao-x` as an explicit profile value and generated trust entry.

## Claude

### Current effective launch

Ordinary declared Claude agents currently use the account home (`~/.claude`) and home-level
`~/.claude.json`. Tachyon only adds one Bridge `--mcp-config` file. Claude also discovers project/local
settings and prompt/capability files from the cwd.

Observed forming surfaces include:

- account config home: credentials, settings, skills, plugins, agents, hooks and memory;
- home-level `.claude.json`: onboarding/account/trust plus cached model/feature state;
- project `.claude/settings.json` (`hooks`, `permissions`);
- project `.claude/settings.local.json` (`prefersReducedMotion`);
- cwd-relative `CLAUDE.md`, `.mcp.json`, skills/plugins/agents and local settings when present;
- command flags for model, prompt, tools, permissions, settings sources, MCP, plugins, agents,
  sandbox/trust directories and resume/fork behavior.

Claude's `--bare` mode explicitly disables automatic hooks, plugin sync, auto-memory, CLAUDE.md
discovery and other ambient customization while allowing explicit prompt/settings/MCP/agent/plugin
inputs. `--setting-sources` controls user/project/local settings but does not by itself prove every
other discovery surface absent.

### Consequence

Claude cannot reuse Grok's adapter shape or honestly attest the current ordinary launch. Canonical
Claude needs a private `CLAUDE_CONFIG_DIR` by default plus a closed launch contract that suppresses
ambient discovery and rematerializes only captured profile/shared inputs. The private home may seed
allowlisted onboarding/trust metadata and symlink credentials, but it cannot copy account model,
prompt, permission, plugin, hook or memory selectors.

### Forming/governing inputs to bind

| Input | Source | V1 canonical treatment |
|---|---|---|
| executable/model/effort | profile selectors / CLI | generated closed args |
| auth/account bootstrap | credential symlink + allowlisted onboarding markers | external auth; non-forming allowlist only |
| system/project guidance | profile/shared references | explicit prompt files/arguments; ambient CLAUDE.md discovery suppressed |
| settings/permissions/hooks | captured profile/shared assignments | generated private settings; project/local discovery suppressed |
| MCP | captured assignments + Bridge | generated `mcp.json` with strict MCP |
| skills/agents/plugins | captured assignments / workspace plugin subsystem | explicit generated paths; no account inheritance |
| cwd/trust/additional dirs | profile workspace + host policy | exact generated args/private trust marker |
| auto-memory | runtime memory policy | disabled unless separately authorized |
| sessions/history/cache/logs | private home | excluded runtime-owned state |

### Required oracle

The adapter must prove the effective command contains the isolation flags selected by the adapter,
uses the exact private home and generated inputs, and cannot load account/project/local forming bytes.
Unknown command flags or generated-file divergence fail closed. Migration equivalence must explicitly
account for the current project `hooks` and `permissions`; silently dropping them is not equivalent.

## Slice boundary

Grok and Claude are independently shippable:

1. Grok can extend the existing private-home generator and projection registry.
2. Claude first needs a closed private-home launch/materialization contract, then its inspector.

`t-7e7464` coordinates both and is complete only when the installed Grok and Claude fixtures pass.
