# Pi — runtime integration status (Tachyon)

**Integration slices:** SDD 398 (Bridge), SDD 399 (continuity), SDD 400 (private home), SDD 401 (Activity), SDD 402 (interaction profile), SDD 403 (reviewer safety), measured against the installed `@earendil-works/pi-coding-agent` on 2026-07-18.

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
| User Pi config preservation | ✓ | No project `.pi` or real `~/.pi/agent` mutation; safe JSON snapshots seed each private home |
| Transcript capture / resume | ✓ | Tachyon-minted `--session-id`, exact `--session <id>`, sessions inside the private home |
| Default private home | ✓ | `PI_CODING_AGENT_DIR=.tachyon/harness/<agent>` plus private `sessions/` |
| Credential isolation | ✓/~ | Initial regular mode-0600 copy; later refresh is agent-local and intentionally not synchronized |
| Fork | ✗ | Deferred with transcript/session semantics |
| Normalized Activity | ✓ | Exact private JSONL → `piNormalizer` → bounded durable `ActivityLogWriter`; automated and Dev Host visual dogfood passed |
| Attention / composer | ✓ | Measured framed editor profile; automated tmux and Dev Host idle/draft proof passed |
| Graceful Stop | ✓ | Measured Escape → Ctrl+C → Ctrl+D sequence; idle/draft/active tmux and Dev Host proof passed |
| Delivery reviewer safety | ~ | `--exclude-tools bash,edit,write`; real active-tool proof passed, human Delivery dogfood pending |
| Runtime model/usage observation | ~ | Generic process/usage surfaces only |
| Opt-in Pi harness capabilities | ✗ | Agent-scoped Pi skills/extensions/packages remain deferred |

## Fail-closed boundaries

- A live Bridge plus a missing staged extension refuses the Pi spawn rather than recording a false wired state.
- Every managed Pi process receives `PI_CODING_AGENT_DIR=.tachyon/harness/<agent>` and `PI_CODING_AGENT_SESSION_DIR=<home>/sessions`; transcript acceptance requires exactly one regular JSONL with matching header id and cwd.
- Tachyon snapshots only regular JSON-object files (`auth.json`, settings, models/model cache, trust and keybindings). The settings snapshot strips `packages`, `extensions`, `skills`, `prompts` and `themes` so executable/instruction resources do not cross the private-home boundary implicitly. Symlinked, malformed or non-regular sources/targets refuse launch before tmux mutation.
- `auth.json` is a private mode-0600 copy, not a symlink: Pi locks by pathname and writes in place, so sibling symlink paths would race one shared target. OAuth refreshes can therefore diverge and are not promoted back to the real home.
- Ambient executable resource trees (`extensions`, `skills`, `prompts`, `themes`, `npm`, `git`, `tools`, `bin`) are not inherited. Trusted project `.pi` resources remain governed by Pi's native project trust.
- Explicit Pi session flags remain user-owned and produce no Tachyon-managed resume record, but they do not opt out of the private runtime home.
- Pi commands using `--no-tools`, `--tools` or `--exclude-tools` are refused while Bridge wiring is required, because Tachyon cannot guarantee the complete Bridge catalog.
- A temporary connection/authentication failure is visible through `/tachyon-bridge-status` and the Pi status line, but Pi remains usable for ordinary local coding.
- `--no-extensions` does not defeat the integration: Pi documents that explicit `--extension` paths still load when automatic extension discovery is disabled.

## Operator check

Restart a Tachyon-managed Pi agent, then run:

```text
/tachyon-bridge-status
```

A healthy session reports `Tachyon Bridge: connected (N tools)`. Asking Pi to call `list_agents` should return the fleet with this process identified by `TACHYON_AGENT_NAME`. Inside a Tachyon Pi process, both `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` must point under the workspace `.tachyon/harness/<agent>` tree, never `~/.pi/agent`.

For continuity dogfood, talk to Pi, stop the managed entry, and use Tachyon's **Resume** action. The reopened Pi process must show the prior conversation. An in-TUI switch to a different session is not followed by Phase 2; Tachyon resumes the exact session id it minted.

## Activity

SDD 401 tails only the exact transcript resolved from the agent's private session directory. `piNormalizer` maps Pi v3 entries into the shared Activity vocabulary: user/assistant messages, thinking, images, tool lifecycle, successful file effects, direct bash commands, model/thinking-level provenance, token usage, interruption, errors and compaction/branch summaries. The durable writer retains bounded offsets and source IDs, strips raw records, and copies rendered image bytes into the existing blob side channel. Unknown/custom-state entries are dropped rather than parsed as another runtime.

## Interaction profile

Pi v0.80.10 renders a glyph-free editor between its final two horizontal rules, followed by cwd and token/model footer lines. SDD 402 adds framed composer-region support so only non-whitespace inside those rules counts as a human draft; changes above/below remain runtime output. Launch readiness requires both borders and the Pi footer, avoiding false readiness on the project-trust selector.

With default Pi keybindings, graceful Stop sends Escape (abort active turn), waits, sends Ctrl+C (clear residual draft), then Ctrl+D with one conditional retry. Isolated tmux dogfood proved clean exit from idle, drafted and active-turn panes. Custom user keybindings can invalidate this measured contract; Tachyon never rewrites `keybindings.json`.

## Delivery reviewer safety

SDD 403 adapts only authoritative Delivery reviewer segments. It injects `--exclude-tools bash,edit,write`, preserving Pi's native `read` and dynamically registered extension/Bridge tools. Real Pi v0.80.10 reported the resulting active catalog as exactly `read` plus the probe extension tool. Conflicting/partial/duplicate tool filters fail before Delivery reservation or spawn. This is a shell-level tool posture, not an OS/network sandbox and not a guarantee that every separately authorized Bridge tool is read-only.
