# 214 — tachyon-verify-gate — notes

## Origin
Roadmap **C3** (Agent0 memory `project_tachyon_overclock_re_roadmap`) — the last worktree-family
item. Merges three convergent ideas: Bernstein's pre-merge "janitor" gate, Agent0 `/squad`'s
verified done-gate, and Overclock's handoff registry (F2). C1 (210) isolate + C2 (213) review →
C3 verify closes the loop with *evidence* that the branch is shippable.

## Confirmed product decisions (2026-06-14, with the maintainer)
- **Studio-driven, stack-suggested, human's final word.** The verify command is chosen in the
  Agent Studio; Tachyon suggests from the detected stack (Node package.json scripts, cargo/go/
  pytest/…) but never imposes — the human picks or types their own. (Mirrors `Tachyon: Init`.)
- **Scope v1 = badge + validated handoff (MCP), together** — not just a human badge. list_agents
  exposes the verify state; a `verify_agent` tool runs the gate; a parent can gate on child+green.
- **Trigger manual v1** — the human sets *what* runs (Studio); the *when* stays a manual Verify
  action/MCP call for v1 (auto-on-idle is a later opt-in; don't fire test suites unprompted).
- **Advisory, never blocking** — merge stays human + plain git; verify is a signal.
- **Reuse commands/runbooks** with a cwd override — no new executor.

## Status
Draft, **design CONFIRMED + planned** (spec/plan/tasks locked). The largest worktree-family
feature (Studio + stack-suggest + worktree-cwd runner + persisted state + badge + MCP handoff).
Not yet implemented — strong fresh-context starting point given the implementation breadth.
TDD + codex dueto when built, like 210/212/213.
