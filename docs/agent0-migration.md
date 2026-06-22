# Agent0 → Tachyon migration — Phase 1 complete

_Recorded 2026-06-22 (Claude Code ↔ Codex duetos on specs 245–249). Status: **Phase 1 (gate migration) substantially COMPLETE.** This doc is the boundary map — what migrated, what structurally cannot, and why — so future "let's migrate X from Agent0" proposals start from the rule, not from scratch._

## Thesis

Make **Tachyon the dev-harness** that an agent fleet runs on, absorbing Agent0's harness *gates* one at a time — minimal repo pollution, Agent0 frozen as the reference, never deprecated. Each candidate is classified **migrate-as-is / adapt / project-domain**.

## The rule the duetos converged on

> **A mechanism migrates only if it anchors at a chokepoint Tachyon OWNS** — project state, the spawn request, the session brief, a declared command. Everything that needs a hook *inside the agent's runtime* does not migrate, because **Tachyon observes an agent from the outside** (a CLI process in a tmux pane); it has no tool-loop hook, no real `SubagentStop`, and no per-bash intercept.

## What migrated (the owned chokepoints — all shipped)

| Agent0 mechanism | Tachyon chokepoint | Spec | Class |
|---|---|---|---|
| session handoff / startup brief | project handoff store + role anchoring | **245**, 216 | adapt |
| delegation-gate (5-field handoff on `Agent`/`Task`) | the Bridge `spawn_agent` **tool** | **246** | adapt |
| `/squad` verified done-gate / validated handoff | per-agent `verify:` in the worktree + `verify_agent` MCP | **214** | adapt |

These four are the migratable surface, and they are done.

## What does NOT migrate (structural — project-domain)

The verify/validation family hit the wall from four directions; both 248 and 249 BLOCKED/document-only after a codex dueto:

| Agent0 mechanism | Why it can't be a Tachyon gate | Resolution |
|---|---|---|
| per-edit validator (lint/typecheck/test/tdd/ui advisories) | no **tool-loop hook** — Tachyon can't fire after an edit | **248** — doc only; per-edit stays project-domain |
| `delegation-verify` (run the done-gate at sub-agent close + one fix-continuation) | no real **`SubagentStop`**; a `dead` child has no process to continue (no fix-loop); a delegated **sub-agent shares the parent worktree** → the verdict can't be attributed to the child; mechanical gate ≠ contract `done_when` | **249** — BLOCKED; "does not migrate" |
| secrets-preflight / governance-gate | gate the agent's **own bash** — no intercept | project-domain (the native `.githooks/pre-commit` already covers it runtime-neutrally) |
| memory hooks (index-gate, frontmatter, journal) | gate the agent's own edits; memory is an Agent0 capability | project-domain |

### The project-domain boundary (the key insight)

These mechanisms **keep working inside Tachyon, for free.** They live in the *runtime's own hook layer* (`.claude/settings.json`, `.codex/hooks.json`) — which belongs to the **project**, not Tachyon. When Tachyon spawns a claude/codex agent **in the project cwd, that agent inherits its project's hooks unchanged** — the validator still validates, secrets-scan still scans, with zero Tachyon involvement.

**So Tachyon's job here is not to absorb them — it is to not break them:** spawn agents in the project cwd, don't strip the runtime's hook config. Nothing to build; this boundary is documented, not migrated.

## Layer-distinct capabilities (not gates — not candidates)

`/sdd`, `/vuln-audit`, `/unused-code`, `/product`, `/frontend-designer`, the capacity tools (`/audio`, `/video`, `/diagram`, …) are Agent0 **capabilities the agent invokes** — not enforcement gates. Tachyon is the **substrate they run on**, never a replacement. They stay Agent0-layer. (The standing rule: never conflate "Agent0 harness capability" with "Tachyon product feature.")

**Two deliberate boundary cases** — overlap with Tachyon's *core* domain, to be decided as design, NOT as gate-migration:
- **`/squad`** — an autonomous two-runtime ping-pong build loop = literally multi-agent orchestration, Tachyon's native domain. The open question is whether Tachyon becomes the **executor** for squad-style loops (it already has pipelines + spawn + the 214 verify-gate), rather than `/squad` re-implementing coordination at the Agent0 layer. → a future deliberate design, not a migration.
- **`/routine`** — recurring project work; Tachyon has `propose_schedule`. Minor overlap; same "design, not migrate" posture.

## Status & next

- **Migration (gate absorption): Phase 1 COMPLETE.** Stop hunting for gates — the remainder is structurally project-domain or layer-distinct.
- **Next deliberate designs (demand-gated, not migration):** the `/squad` domain-convergence question; hardening/proving the shipped Tachyon surface.
