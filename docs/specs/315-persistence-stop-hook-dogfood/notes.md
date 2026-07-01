# 315 — persistence-stop-hook-dogfood — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Dogfood log

### 2026-07-01 — persisted-agent Stop/Resume

- Maintainer installed/reloaded the current VSIX and stopped/resumed the persisted `codex` section from the Tachyon
  sidebar.
- `silent-persistence-hooks.json` shows `codex.active=true` with `updatedAt=2026-07-01T23:11:49.944Z`, so the resumed
  session had Tachyon silent hooks marked active.
- `tmux list-panes` showed the live `codex` command included a session-scoped `-c` override containing both
  `hooks.SessionStart=...` and `hooks.Stop=...`.
- `.tachyon/activity/session-owners.jsonl` received current `codex` rows at `2026-07-01T23:13:04Z`, proving
  `SessionStart` is active for the resumed TUI session.
- `.tachyon/activity/persistence-stop.jsonl` has 8 rows total and all are `agent:"claude"`; there is no `codex` or
  `codex-2` Stop row after the maintainer dogfood.
- `.tachyon/activity/persistence-hooks-failures.jsonl` was empty, so this is not a recorded hook-script exception.
- A controlled `codex exec` probe with a minimal `hooks.Stop` command and `--dangerously-bypass-hook-trust` wrote the
  expected Stop row, proving Codex CLI 0.142.5 has a working Stop hook event in at least the exec path.
- The same controlled `codex exec` probe without `--dangerously-bypass-hook-trust` produced the model response but did
  not write the Stop row.
- `~/.codex/config.toml` contains `/<session-flags>/config.toml` trust entries for `session_start`, but no matching
  `stop` trust entry. Current conclusion: Codex TUI Stop is blocked by hook trust for Tachyon's session-scoped Stop hook,
  not by missing injection.

Decision: do not close this spec as shipped. The Codex acceptance criterion is not satisfied yet, and adding
`--dangerously-bypass-hook-trust` to normal Tachyon-spawned Codex agents would be too broad because it can also bypass
unrelated project/user hooks.
