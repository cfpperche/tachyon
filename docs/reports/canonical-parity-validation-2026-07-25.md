# Canonical parity validation — 2026-07-25

## Scope

Validation task `t-4a7df6` audits the readiness gate for canonical Claude, Codex, Grok, and Pi
before recommending new agent creation. It compares the living matrix, machine-readable runtime
profiles, lifecycle regressions, completed parity slices, and Agent Studio readiness presentation.

## Evidence that holds

| Runtime | Fresh / restart / resume | Explicit limitation | Result |
|---|---|---|---|
| Codex | `test/unit/agentManager.test.ts` canonical private-policy regression | no native fork | lifecycle test passes; Studio shows fork unavailable |
| Claude | same test file regenerates private settings, skills, MCP and trust | no typed authored policy; explicit CLI mode overrides settings default | active-turn stop is measured; partial permission posture is shown |
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

**Recommend creation of the new Claude/Codex/Grok/Pi agent set with the displayed limitations.**
Claude's authorized active-turn measurement closed `t-b727bd`: Escape, Ctrl+C, then `/exit` ended
the Claude Code 2.1.220 pane with status 0. The measured settings `defaultMode=plan` is overridden
by an explicit `--permission-mode auto`; Tachyon has no typed authored Claude policy field and does
not synthesize one, so the Studio correctly retains its partial permission-posture limitation.

The Agent Studio visual automation result remains `unable_to_judge` because this worktree has no
browser launcher, but it is not a release criterion: the Companion is not a development tool. The
structured UI tests and production build are the validation evidence for this surface; this report
does not claim an unperformed visual inspection.

Pi's one-live OAuth admission, Codex's missing native fork, Grok's unprojected permission policy,
and Claude's intentionally partial authored-policy posture are acceptable *modelled limitations*.
They are surfaced before lifecycle actions and do not block baseline release of umbrella `t-824668`.
