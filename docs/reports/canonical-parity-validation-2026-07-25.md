# Canonical parity validation — 2026-07-25

## Scope

Validation task `t-4a7df6` audits the readiness gate for canonical Claude, Codex, Grok, and Pi
before recommending new agent creation. It compares the living matrix, machine-readable runtime
profiles, lifecycle regressions, completed parity slices, and Agent Studio readiness presentation.

## Evidence that holds

| Runtime | Fresh / restart / resume | Explicit limitation | Result |
|---|---|---|---|
| Codex | `test/unit/agentManager.test.ts` canonical private-policy regression | no native fork | lifecycle test passes; Studio shows fork unavailable |
| Claude | same test file regenerates private settings, skills, MCP and trust | policy precedence and active-turn stop remain partial (`t-b727bd`) | limitation is shown; not promoted to full parity |
| Grok | same test file regenerates trust and preserves external auth/Bridge | no authored permission policy; composer/attention unverified | limitation is shown; canonical HOME/GROK_HOME isolation is covered |
| Pi | same test file regenerates exact trust/private state | OAuth allows one live Pi agent only; headless probe unavailable | limitation is shown; admission remains enforced |

Focused command run during this audit:

```text
npx vitest run test/unit/agentManager.test.ts -t 'canonical (Claude|Grok|Pi|Codex) regenerates'
4 passed
```

The main integration commit is `1fbb6adc`; it adds the structured readiness projection and Agent
Studio rendering. The focused Studio suite (52 tests), `npm run typecheck`, and
`npm run verify:full:quiet` passed at that commit.

## Matrix corrections

The Codex detailed table had stale rows that contradicted its summary: graceful stop was still
described as declared/unverified and permission injection as partial. The current runtime profile
and `t-60ff74` provide measured/verified stop plus lifecycle-bound `approval_policy` and
`sandbox_mode` projection. This audit updates those detailed rows and adds a native-config row.

## Release decision

**Do not recommend or create the new Claude/Codex/Grok/Pi agent set yet.** The baseline has honest
runtime limitations, but the umbrella requires a real dogfood record for every runtime and a visual
inspection of the Agent Studio readiness surface. The current evidence has two explicit gaps:

1. Claude's active-turn stop and authored permission-policy precedence are still
   open in `t-b727bd`.
2. Agent Studio visual QA is `unable_to_judge`: the preview bundle builds, but this worktree lacks
   the provisioned `agent-browser` launcher (`BROWSER_RUNTIME_MISSING`).

Pi's one-live OAuth admission, Codex's missing native fork, and Grok's unprojected permission policy
are acceptable *modelled limitations*; they are not release blockers by themselves. The two gaps
above prevent marking umbrella `t-824668` done under its stated gate.
