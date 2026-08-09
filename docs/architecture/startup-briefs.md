# Startup briefs

Tachyon calls the complete opening context offered to a fresh or restarted agent a **startup
brief**. A **task/spawn contract** is only one optional layer inside that aggregate: the structured
delegation containing `TASK`, `CONTEXT`, `CONSTRAINTS`, and exactly one of `DELIVERABLE` or
`DONE_WHEN`.

This distinction matters for persistent declared agents. They may start with repository guidance,
identity or role context but no current task. Operational context is not evidence that a delegation
was supplied or lost.

## Who generates it

`AgentManager` composes startup briefs at fresh spawn and restart for agent runtimes with a supported
opening-prompt channel. Tachyon obtains each layer from its canonical owner:

1. project guidance explicitly configured by the workspace;
2. optional user-authored soul identity;
3. optional role template and persistent instructions;
4. optional Bridge coordination guidance;
5. optional current execution brief or structured task contract.

The Tachyon primer precedes that body and the before-finishing reminder follows it. Explicit
resume/continue/session-id commands own their existing transcript and receive no new startup body.
Terminals and agent runtimes without a startup-prompt adapter do not receive content Tachyon cannot
deliver honestly.

Project guidance is opt-in. Tachyon never discovers `AGENTS.md`, `CLAUDE.md` or repository policy by
convention. When `settings.projectGuidance.files` is absent, that layer is absent. When configured,
the declared files are read from the workspace that owns `tachyon.yml`, preserved in declared order,
and rendered inside the source-labelled `PROJECT GUIDANCE (PROJECT-OWNED)` block.

## Inline and file delivery

The flattened body is measured in shell-escaped transport bytes. At or below 4,000 bytes it remains
inline. Above that threshold Tachyon writes a private derived file atomically at:

```text
.tachyon/briefs/spawn/<agent>.md
```

and sends the runtime a bounded summary plus an absolute pointer. This keeps the pane well below the
measured tmux single-payload rejection range. A separate safe inline ceiling still fails closed when
file writing is unavailable and fallback would be unsafe.

The long file begins with a fixed, content-free inventory. Example:

```text
── STARTUP BRIEF CONTENTS ──
Project guidance: 2 sources
Soul: absent
Role: absent
Persistent instructions: absent
Bridge guidance: absent
Task: absent
── END STARTUP BRIEF CONTENTS ──

── PROJECT GUIDANCE (PROJECT-OWNED) ──
...
── END PROJECT GUIDANCE ──
```

The inventory contains only bounded flags, the project-guidance source count, and the closed
`DELIVERABLE|DONE_WHEN` discriminator. It never contains task text, source paths, soul bytes,
instructions, credentials or other free-form content. The pre-existing flattened body follows as an
exact contiguous suffix, so the inventory cannot rewrite or truncate it.

A guidance-only pane pointer explicitly reports `task contract (absent)` and that the launch supplied
no task brief. A delegated long pointer instead reports `task contract (DELIVERABLE)` or
`task contract (DONE_WHEN)` from the validated structured object. Tachyon does not infer this by
parsing Markdown.

## Freshness and authority

The pointer in the current launch's pane or runtime startup environment is the witness that a long
file was offered for that launch. The mere existence of `.tachyon/briefs/spawn/<agent>.md` proves
nothing about the current task: a later inline launch deliberately leaves an older file available as
postmortem residue but does not reference it.

Inspection therefore starts from the current pane/session, not by scanning `.tachyon/briefs`. The
file and its inventory are derived context, never authority for Board status, Delivery,
verification gates, approvals or permissions.

Replacement uses a private same-directory temporary file followed by atomic rename. Preview and pane
size validation happen before replacement, so a failed restart preserves both the live session and
the prior complete file. Re-anchor uses a separate namespace:

```text
.tachyon/briefs/reanchor/<agent>.md
```

and cannot overwrite startup context.

## Diagnostic contract

Aggregate-facing messages say **startup brief**. Structured delegation APIs and their validated
object retain **SpawnContract**. Re-anchor messages say **re-anchor context**. Errors may report
purpose, stage, UTF-8 bytes, shell-escaped transport bytes and destination, but never dump the body.

For a missing task, do not infer or claim work from an old file, git status, project handoff or the
Board queue. Wait for an explicit user direction or a real delegated task contract.
