# 375 — persistent-workspace-bridge — notes

_Created 2026-07-13._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-13 — bounded implementation candidate

The original headless-engine design was deliberately reduced after maintainer feedback. The candidate keeps the
engine in the Extension Host and adds a detached stable-port proxy with an owner-only Unix control socket. During
reload the proxy returns immediate `HOST_UNAVAILABLE`; after reattach the same endpoint works without agent restart.
Focused proxy/Bridge/Workspace/i18n tests pass 110/110, typecheck and diff-check pass, and the real child-process
dogfood proves stable PID/port across detach/reattach. The first full run found only two new l10n calls; both were
replaced with repo-required plain strings and the focused i18n gate is green. Installed-VSIX reload dogfood and the
final full gate remain.

## 2026-07-13 — reload dogfood correction

Installed dogfood of 0.55.96 showed the stable port survived only because a new proxy was spawned after reload:
the proxy PID/instance changed and the old proxy was a direct Extension Host child. The Linux/WSL launcher now uses
`systemd-run --user --collect` so the user manager owns the proxy process. Headless dogfood was updated to prove the
proxy is not a direct child of the caller and still keeps one PID/port/instance across backend detach and reattach.
