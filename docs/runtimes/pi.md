# Pi — runtime integration status (Tachyon)

**Integration slice:** SDD 398, measured against the installed `@earendil-works/pi-coding-agent` on 2026-07-18.

Pi is a recognized Tachyon AI runtime. Tachyon starts it in tmux, injects `TACHYON_AGENT_NAME`, the Bridge URL and a per-agent bearer, delivers the universal onboarding primer as Pi's positional startup message, and additively loads an immutable bundled Pi extension with `--extension`.

Pi deliberately has no built-in MCP client. Tachyon's extension opens the local Streamable HTTP MCP Bridge, discovers its tool catalog and registers each entry through Pi's native extension tool API. The extension never writes `.pi`, `~/.pi`, a bearer file, or a bearer argv value.

## Current capability

| Capability | State | Mechanism |
|---|---:|---|
| Managed tmux lifecycle | ✓ | Generic Tachyon agent lifecycle |
| Opening primer / project guidance | ✓ | Pi positional startup message |
| Authenticated Bridge tools | ✓ | Bundled additive Pi extension |
| Per-agent Bridge identity | ✓ | `TACHYON_AGENT_BRIDGE_TOKEN` in process env |
| Spawn / restart reinjection | ✓ | Shared `withRuntimeBridge` lifecycle seam |
| User Pi config preservation | ✓ | No `.pi` or `~/.pi` mutation |
| Transcript capture / resume | ✓ | Tachyon-minted `--session-id`, exact `--session <id>`, private per-agent session directory |
| Fork | ✗ | Deferred with transcript/session semantics |
| Normalized Activity | ✗ | Phase 3; exact JSONL path is now available but not normalized |
| Runtime model/usage observation | ~ | Generic process/usage surfaces only |
| Harness/private Pi home | ✗ | Not part of SDD 398 |

## Fail-closed boundaries

- A live Bridge plus a missing staged extension refuses the Pi spawn rather than recording a false wired state.
- Managed Pi sessions are stored under `.tachyon/pi-sessions/<agent>` via `PI_CODING_AGENT_SESSION_DIR`; transcript acceptance requires exactly one regular JSONL with matching header id and cwd.
- Explicit Pi session flags remain user-owned and produce no Tachyon-managed resume record.
- Pi commands using `--no-tools`, `--tools` or `--exclude-tools` are refused while Bridge wiring is required, because Tachyon cannot guarantee the complete Bridge catalog.
- A temporary connection/authentication failure is visible through `/tachyon-bridge-status` and the Pi status line, but Pi remains usable for ordinary local coding.
- `--no-extensions` does not defeat the integration: Pi documents that explicit `--extension` paths still load when automatic extension discovery is disabled.

## Operator check

Restart a Tachyon-managed Pi agent, then run:

```text
/tachyon-bridge-status
```

A healthy session reports `Tachyon Bridge: connected (N tools)`. Asking Pi to call `list_agents` should return the fleet with this process identified by `TACHYON_AGENT_NAME`.

For continuity dogfood, talk to Pi, stop the managed entry, and use Tachyon's **Resume** action. The reopened Pi process must show the prior conversation. An in-TUI switch to a different session is not followed by Phase 2; Tachyon resumes the exact session id it minted.
