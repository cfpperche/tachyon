# 262 — sidebar-domain-actions — duet

_Created 2026-06-25._

This file captures a lightweight Codex/Claude duet for the draft spec. It is not a formal locked implementation plan.

## Codex opening

The core proposal is to separate shell concerns from sidebar-visible domain mutations. The observed pin-delete drift was not enough to justify a broad command rewrite, but it is enough to justify a small shared action seam so the sidebar and command handlers do not duplicate or indirectly chain mutation + refresh behavior.

Where pushback is requested:

- Whether v1 should include command/runbook deletion or stay with pins plus schedules/proposals.
- Whether the seam belongs under `workspace`, `sidebar`, or a neutral action/controller module.
- Whether direct calls from `SidebarPrototypeProvider` are acceptable, or dependency injection is worth it now.

## Claude review

**Verdict: SHIP-WITH-CHANGES.**

Claude agreed the problem is real and the initial scope is mostly right: `SidebarPrototype.ts` currently mixes direct store/repush for pins with command-handler fanout for schedules/proposals/commands/runbooks. That split is the same class as the spec 261 pin-delete drift.

Main critique:

- The draft under-specified the refresh contract. Sharing mutation is not enough if pins keep using host-local `this.push()` while schedules use `onViewsChanged("schedules")`. The spec must say whether pin actions standardize on `onViewsChanged("pins")` or another shared refresh callback.

Scope recommendation:

- Exclude command/runbook deletion from v1. Those handlers carry confirmation modal concerns and would force the spec to solve shell confirmation boundaries before proving the action seam.
- Keep v1 to pins plus schedules/proposals.

Placement recommendation:

- Put the seam under `src/workspace/`, preferably a narrow `domainActions.ts`, not under `src/sidebar/`. A sidebar-owned action layer would invert the shell/engine dependency.
- Consider injecting the controller into `SidebarPrototypeProvider` because the provider already uses injected dependencies and this would improve unit tests.

Acceptance criteria to tighten:

- Pin mutation criteria must specify refresh/event path.
- Add regression coverage that deleting one pin does not clear or reorder sibling pins.
- Multi-root stale hashes should be an explicit no-op, not merely "not workspace zero".
- Use a concrete shell-only example such as `command:open` or `pin:copy`.

## Codex synthesis

Folded into `spec.md` on 2026-06-25:

- Added mutation + refresh/event language to the intent and pin acceptance criteria.
- Added sibling-preservation and stale-hash no-op acceptance.
- Resolved v1 scope to pins plus schedules/proposals, leaving command/runbook deletion out.
- Narrowed the open questions to module-vs-controller shape and exact pin refresh mechanism.

Follow-up planning decision:

- Use `src/workspace/domainActions.ts` as a pure function module.
- Pass an explicit `onChanged(view)` dependency into domain actions. This keeps the module VS Code-free while standardizing mutation + refresh/event behavior.
