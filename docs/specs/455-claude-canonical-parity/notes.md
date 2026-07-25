# 455 — claude-canonical-parity — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Retain the existing workspace-authored `settings.json` permission block as the canonical projection.
  The installed CLI accepts all six `--permission-mode` values, but that only proves parser support;
  it does not establish settings/argv precedence safe enough to synthesize a profile-wide policy.
  In particular, the ownership-only ad-hoc `auto` convenience is not canonical authority.

## Evidence

- The AgentManager lifecycle test now mutates private settings, skills, MCP, and trust state between
  fresh spawn, restart, and resume, then proves all three materializations are identical and exclude
  ambient/stale state.
- Claude Code 2.1.220 accepted `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, and
  `plan`, while rejecting an invalid value under `--help` parsing.
- A disposable `CLAUDE_CONFIG_DIR` TTY exited from interactive onboarding after interruption plus
  repeated EOF. It did not provide evidence for a provider-active turn or a drafted composer.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- `t-b727bd` owns active-turn/drafted-composer graceful-stop measurement and native permission
  settings-versus-argv precedence. Until it lands, Claude stop, permission injection, and authored
  native-config policy remain `~` in the parity matrix.
