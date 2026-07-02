# 334 — agent-desktop-control — plan

_Drafted from `spec.md` on 2026-07-02._

## Approach

Create a new `agent-desktop` plugin in `/home/goat/tachyon-plugins`, parallel to `agent-screen`. It should expose a
single script-backed skill with explicit commands for app/window control. V1 uses the same Windows-host from WSL model
that proved reliable for `agent-screen`: a bash wrapper resolves Tachyon-provisioned context and invokes a temporary
PowerShell helper for Win32 window/app operations.

The plugin should not capture pixels. Instead it makes the target app/window available, then the agent validates with
`agent-screen`. This keeps "eyes" and "hands" separate and makes risk easier to reason about.

## Proposed CLI

```bash
agent-desktop doctor
agent-desktop list-windows --json [--verbose]
agent-desktop launch --app <name-or-path> [--json]
agent-desktop open-url --browser chrome [--new-window] <https-url> [--json]
agent-desktop wait-window --process <name> [--title <substring>] --timeout <seconds> [--json]
agent-desktop focus --window-id <id> [--json]
agent-desktop focus --process <name> [--title <substring>] [--json]
agent-desktop restore --window-id <id> [--json]
```

The exact command set may shrink during implementation if one command duplicates another without adding clarity.

## Key decisions

- **New plugin, not `agent-screen` expansion** — `agent-screen` remains screenshot evidence; `agent-desktop` mutates the
  desktop and therefore needs a different safety contract.
- **V1 avoids mouse/keyboard** — launch/focus/restore/wait/open-url solves the immediate "open software before screenshot"
  use case while avoiding arbitrary input automation.
- **Windows-host first** — current dogfood runs WSL + Windows desktop; cross-platform backends can follow after the
  contract is stable.
- **Explicit consent model** — the user consents to desktop mutation. Privacy filtering/redaction is future work, but
  commands remain explicit and bounded.
- **Structured stdout** — commands report selected window ids, process, bounds, and performed state changes so agents can
  chain into `agent-screen` deterministically.
- **No `ensure` in v1** — agents can compose the primitive commands. A composite command can follow after launch/focus
  semantics are proven.
- **Deterministic browser opening** — Chrome should open a new window by default for `open-url`, and `wait-window` should
  support title matching. Waiting only on `--process chrome` is racy because Chrome is single-instance and multi-process.
- **All command outputs are JSON-capable** — every state-changing command should support stable machine-readable output
  and a documented exit-code taxonomy.

## Files touched

- `/home/goat/tachyon-plugins/agent-desktop/tachyon-plugin.json` — new plugin manifest.
- `/home/goat/tachyon-plugins/agent-desktop/README.md` — command contract, consent, examples.
- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/SKILL.md` — agent-facing invocation and safety rules.
- `/home/goat/tachyon-plugins/agent-desktop/skills/agent-desktop/scripts/agent-desktop.sh` — CLI implementation.
- `/home/goat/tachyon-plugins/README.md` — marketplace/listing row.
- `docs/specs/334-agent-desktop-control/*` — planning, validation, dogfood notes.

## Risks & Unknowns

- Opening/focusing apps can steal focus while the user is working.
- App names are host-specific; browser/app resolution needs clear error messages.
- `open-url` can expose private browsing/account context; consent covers the initial version, but docs must be direct.
- Ambiguous process/window matching must fail closed.
- Windows foreground restrictions may make `SetForegroundWindow` unreliable unless the process context allows it.
- Elevated windows can be blocked by UIPI; focus/restore failures must be explicit.
- Launching apps by bare name can be brittle; v1 may need a small alias table for common apps such as Chrome, VS Code,
  Discord, Explorer, and Settings.
- Window ids are HWNDs and may become stale/reused; commands must validate target existence before mutating it.
- Per-monitor DPI can make coordinates inconsistent; the helper should declare DPI awareness and report physical pixels
  to match `agent-screen`.
- PowerShell interop per command can be slow; `wait-window` needs a bounded polling strategy and timeout defaults.

## Implementation Spikes

Before building the full plugin:

1. Probe foreground/focus reliability from WSL PowerShell against Chrome and VS Code.
2. Test direct `ShowWindow + SetForegroundWindow` and at least one fallback strategy.
3. Confirm `open-url --browser chrome --new-window <url>` produces a targetable top-level window.
4. Confirm `wait-window --process chrome --title <substring>` avoids stale-window false positives.
5. Confirm physical-pixel bounds match `agent-screen`.

## Visual Impact

The plugin mutates the user's real desktop by launching/focusing/restoring apps. Visual proof should be collected with
`agent-screen`, not by `agent-desktop` itself.

Dogfood should use `agent-desktop` for restore/focus and `agent-screen` only for capture. `agent-screen
--restore-minimized` remains a convenience shim, but this spec should not use it as proof that `agent-desktop` works.

## Sources Consulted

- `docs/specs/283-agent-screen-primitive/*` — established plugin pattern for desktop screenshot primitives, Windows-host
  backend, explicit consent, dogfood evidence, and minimized-window restore.
- `/home/goat/tachyon-plugins/agent-screen/*` — implementation template for manifest, README, skill, shell wrapper, and
  PowerShell helper style.
- Claude Fable probe `probe-237fa645-b227-41c8-849f-b0946c8b8e78` — adversarial review of v1 scope, CLI shape,
  consent/safety, Windows/WSL gotchas, and dogfood determinism.
