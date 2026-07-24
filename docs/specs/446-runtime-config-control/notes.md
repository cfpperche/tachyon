# 446 — runtime-config-control — notes

_Created 2026-07-24._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Slice A inventories only Codex `~/.codex/config.toml` and workspace `.codex/config.toml`. It reports the six scalar fields already measured by SDD 442, MCP server names, source revision/path, and non-MCP unknown key paths. It never sends file bytes, MCP command bodies, or environment values to the webview.
- The agent list is explicitly labelled potential. This slice can identify Codex agents, but does not yet carry each canonical profile's family/source selection into Control; claiming an exact effective relationship would be misleading.
- The source-file action is constrained host-side to the two paths emitted by the current snapshot, so a forged webview message cannot open arbitrary local files.
- Runtime-managed `hooks.state.*` records are counted and summarized separately. They are not useful human configuration and their many trust hashes must not drown out actual unknown settings.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- Slice B supports the six measured scalar fields and reversible enable/disable of an existing named
  Codex MCP by commenting its exact source block with a Tachyon marker. It deliberately does not
  provide an MCP creation/editor form:
  command, arguments, transport and environment shapes have not been measured as a safe visual
  schema, and a generic form would either conceal important data or recreate an unbounded TOML editor.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- The approved visual prototype included simulated skills, hooks, extensions, per-item toggles, and Claude/Grok examples. They are removed from the shipping viewer until their native source formats and effective-launch behavior are measured. The viewer is intentionally smaller but truthful.
- A full SHA-256 revision travels with the content-free source inventory. This is not displayed as
  configuration; it is used only to reject a save if the native file changed after the page was read.

## Implementation follow-up

- Runtime Config keeps a draft per selected scope and commits all changed measured fields and MCP
  toggles in one revision-checked atomic write. Cancel restores the last inventory snapshot.
- The Control shell uses the shared Product Toast provider; the old per-cockpit toast stack is no
  longer rendered.
- Slice C keeps freshness in the engine: a successful save marks only running canonical Codex agents
  whose profile selects the changed global/workspace source. The active session is not interrupted;
  the pending flag is cleared by the existing successful spawn callback used by Start, Restart, and
  Resume, which also emits a concise launch-boundary notice.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
