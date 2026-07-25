# Pi project-trust boundary (`t-68ee7a`)

Date: 2026-07-25  
Runtime inspected: `pi` 0.80.10 (`@earendil-works/pi-coding-agent`)

## Decision

Pi does have a native project-trust gate equivalent to the folder gates in other runtimes. Canonical
Pi is not yet at exact-trust parity: Tachyon copies the ambient `trust.json` into a new private home
once, then leaves that private file runtime-owned across rematerialization. This can import unrelated
grants and denials, and later restarts/resumes retain stale decisions.

Do not mark Pi trust parity complete from the existing private-home implementation. Implement the
bounded correction in follow-up `t-20c856`: canonical profiles must replace `trust.json` on every
fresh/restart/resume materialization with exactly the canonical workspace root and effective cwd,
both trusted. Non-canonical Pi homes keep their existing runtime-owned seed semantics.

## Native contract

The installed runtime source and documentation agree on the following contract:

- File: `$PI_CODING_AGENT_DIR/trust.json` (normally `~/.pi/agent/trust.json`).
- Schema: a JSON object keyed by canonical absolute directory. Values accepted by the parser are
  `true`, `false`, or `null`; writes remove `null` entries and persist booleans.
- Lookup: Pi canonicalizes the cwd and walks toward the filesystem root. The closest saved boolean
  on the current path or an ancestor wins.
- Gate trigger: a project needs trust when it contains protected `.pi` settings/resources, or when
  `.agents/skills` exists in the cwd or an ancestor (excluding the user-global skills directory).
- Authority granted: trusted project settings, extensions, skills, prompts, themes, system prompt
  files, and missing project packages may load or execute. This is an input-loading boundary, not an
  operating-system sandbox.
- Interactive default: `defaultProjectTrust: "ask"` shows a prompt. Non-interactive modes do not
  prompt; absent a decision, `"ask"` behaves as untrusted unless `--approve` is supplied.
- `/trust` can persist the exact cwd or its immediate parent. Parent grants intentionally cover
  descendants.

## Current Tachyon behavior and risk

`HarnessManager.materializePiBaseHome` treats `trust.json` like the other inert JSON seed files:

1. It validates the ambient source and private target as regular, no-follow JSON-object files.
2. It copies the source only when the target does not exist.
3. It validates and chmods the private target to `0600`.
4. On later materializations it preserves whatever the private runtime wrote.

That policy is suitable for runtime-owned preferences but not for canonical trust:

- Every ambient path decision crosses into a new canonical agent, including unrelated repositories.
- An ambient parent grant can authorize every descendant without the canonical profile naming them.
- A stale private `true`, `false`, or parent decision survives restart and resume.
- The canonical materialization routes do not currently pass the effective cwd into the Pi base-home
  writer, including the captured-capability route.

The real ambient fixture on this host was a one-entry object mapping the Tachyon workspace to `true`;
no credential or secret content was inspected or recorded.

## Runtime evidence

A disposable project containing `.pi/settings.json` was launched with an isolated
`PI_CODING_AGENT_DIR`, offline mode, telemetry disabled, and an empty `trust.json`. Pi 0.80.10 showed
`Trust project folder?` for the exact canonical project path. The prompt was cancelled without
persisting a decision.

The same runtime and project were relaunched after the isolated trust file was replaced with:

```json
{
  "<canonical-project-path>": true
}
```

Pi entered its normal TUI without the trust prompt. This proves that exact native materialization is
available and that parity must be implemented rather than dismissed as a missing runtime feature.

## Required implementation proof

Follow-up `t-20c856` should demonstrate:

- exact canonical workspace + effective cwd entries on fresh, restart, and resume;
- removal of ambient, sibling, stale-parent, stale-denial, and stale-grant entries;
- canonical path normalization and deduplication;
- regular no-follow target, mode `0600`, and safe replacement before launch;
- preservation of private auth, settings, captured resources, sessions, and Bridge extension wiring;
- real Pi first boot in a trust-gated disposable project without auto-answering a prompt.

