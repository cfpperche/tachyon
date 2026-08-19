# t-e050fd measurements

## Legacy agent/profile collision

Measured through `loadProfileAwareConfig` on the production profile-aware loading door: when
`tachyon.yml` declares `agents.codex` and `.tachyon/agents/codex/agent.yml` exists with valid
authority, the canonical profile wins. The loader removes the whole legacy `agents:` block before
the legacy parser sees it, projects the directory profile into the roster, and emits the legacy
warning. The two definitions are not merged, and the inline `cmd` cannot override the profile.

## Other top-level blocks

`terminals:` is still a live compatibility path. `terminals:` entries in `tachyon.yml` continue to
load; a same-name `.tachyon/terminals/<name>.yml` declaration supersedes the legacy entry and emits
the corresponding compatibility warning. A canonical agent and a legacy terminal with the same name
still collide in the shared parser namespace and both are dropped, so this task does not broaden the
agent change to terminals.

`schedules:` is also still parsed from `tachyon.yml`, including validation of its interval/time and
declared-agent reference. No directory-backed schedule source was found in this measurement, so it
is not changed.

## Revised decision and fail-before evidence

The owner revised the decision during implementation: remove the path rather than ship a permanent
deprecation warning. The schema no longer advertises `agents`, and the profile-aware loader removes
the block before ordinary parsing. Direct `parseConfig` callers now receive the normal unknown
top-level-key warning, while the production profile loader keeps canonical profiles and settings
loading without a migration warning.

Before the removal, the focused regression assertion was red:

```text
FAIL test/unit/failClosedDoors.test.ts > schema labels agents: as legacy and points to the canonical profile path
Expected: "LEGACY"
Received: "Agents (AI CLIs, dev servers, watchers — any command) keyed by name. May be empty or omitted."
```

After the revised implementation, `parseConfig` has no legacy compatibility flag and no `raw.agents`
read. The existing tests that directly assert the retired inline shape are now expected to fail until
they are rewritten; they are test fixtures, not production consumers. The profile-loader and config
door tests cover the positive unknown-key path, settings preservation, canonical-profile collision
behavior, and the absence of any continued `raw.agents` parsing.
