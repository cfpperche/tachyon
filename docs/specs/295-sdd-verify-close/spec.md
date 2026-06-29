# 295 — sdd-verify-close

_Created 2026-06-29._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** Shipped 2026-06-29 in the `sdd` plugin at `1.2.0` (`tachyon-plugins`, commits `feat(sdd)…` + fold `b77a669`). Two bundled bash scripts (`spec-verify.sh`, `sdd-close.sh`) + two wired subcommands (`/sdd verify`, `/sdd close`), a faithful port of the back-half lifecycle adapted to the Tachyon trust model. Both codex duetos folded — design (SHARPEN, "verify needs a real execution gate" → preview-by-default + `--run`) and impl (NEEDS-REVISION → resolved): the two containment BLOCKERs (empty-`SPECS_ROOT` glob-degradation → require docs/specs; logical-path symlink escape → `pwd -P` physical canonicalization), the `--run --json` pre-execution print (now always on stderr), the `NNN` target alias, and the SKILL invocation-path correction. Verified by a headless install dogfood (5/5): close read-only sweep flags shipped specs + skips drafts; verify previews by default (runs/writes nothing) and only executes + logs `notes.md` with `--run`; BLOCKER1 (no-`docs/specs` refuses an absolute external target) + BLOCKER2 (symlink escape refused, the command never runs); the `NNN` alias; `--run --json` clean JSON on stdout + the command announced on stderr; no origin-harness leak in the materialized scripts/SKILL. Non-goal kept: the automatic post-edit advisory-nag form (needs a Tachyon validator framework, deliberately not built). Pending (gated): push + tag `tachyon-plugins` on the owner's OK.

## Design decisions (folded from the 2026-06-29 codex design dueto — "port is right, but verify needs a real execution gate")

The `sdd` plugin today ships only the AUTHORING half of the spec lifecycle (`new / refine / debate / plan / tasks /
list`). The BACK half — mechanical re-verification + close-out hygiene — is missing, and the owner confirms it hurts.
This spec adds it as **on-demand subcommands** `/sdd verify` + `/sdd close`, porting two deterministic markdown+shell
auditors (faithful but adapted to the Tachyon/plugin reality). The automatic post-edit "advisory nag" form is OUT of
scope (it needs a post-edit-validator framework Tachyon deliberately does not have).

- **D1 — root resolution (adapted + hardened).** git-root first; if no git root, fall back to `$PWD` ONLY when it
  contains `docs/specs` (or the target resolves under it). DROP the origin's script-location fallback (`dirname/../..`
  → the materialized `.claude/skills` path is not a repo anchor). **REJECT any target outside `<root>/docs/specs/*`** —
  never run/audit a random directory's markdown.
- **D2 — NO validator coupling.** The scripts run ON-DEMAND only; strip every "post-edit validator emits …-advisory" /
  "recent shipped specs" framing. `close` keeps its intrinsic filter (audit only `shipped`/`shipped-partial` specs).
- **D3 — de-origin the shipped scripts.** No origin-harness names, rule paths, or origin spec numbers in the shipped
  plugin code (this spec's history is the only place that names them).
- **D4 — runtime-neutral script path.** Do NOT hardcode `.claude/skills/sdd/...` (the plugin is claude **and** codex —
  codex materializes to `.agents/skills/`). The SKILL instructs "run the bundled script in this skill's `scripts/`
  dir" (mirrors how `new` is already invoked); the agent resolves the materialized path for its runtime.
- **D5 — target resolution.** `verify <spec>` REQUIRES a target (accept `NNN` or an explicit spec dir; `NNN` errors on
  multiple matches; if a "latest" convenience is offered it prints the resolved path before acting). `close [<spec>]`
  defaults to the all-shipped sweep and also accepts a specific spec.
- **D6 — jq stays OPTIONAL.** Keep the existing jq-or-pure-shell fallback for `--json`; add no plugin dependency.
- **D7 — bash, declared honestly.** The scripts use bash (not POSIX `sh`); invoke them with `bash` and state the
  requirement. Runtimes stay `claude` + `codex` (both run bash + relay output).
- **D8 — precise opt-in contract.** `**Verify:** \`<cmd>\`` (in tasks.md, fallback spec.md) opts a spec into `verify`.
  `**Status:** shipped|shipped-partial` makes a spec eligible for `close`. `**Closure:**` is what makes a close result
  CLEAN (its absence is the `missing-closure` finding). Bump the plugin `1.1.0 → 1.2.0`.
- **D9 — write discipline.** `spec-verify` appends a `## Verification log` block to the spec's `notes.md` ONLY AFTER an
  actual run; `sdd-close` is read-only (writes nothing, ever). The verify PREVIEW (default) writes nothing.

- **DECISION (OQ1, the crux — codex CONFIRMED a consent concern):** `verify` executing a command **selected
  indirectly from a markdown file** is NOT equivalent to "running any project script" — in a marketplace skill an agent
  may invoke `/sdd verify` as a lifecycle helper without the human seeing the exact command, and a malicious branch
  could swap `**Verify:**` for a destructive/exfiltrating command. So `verify` is **PREVIEW-BY-DEFAULT**:
  - `sdd verify <spec>` with NO `--run` → prints the resolved spec path + the extracted command(s) and **EXITS without
    running or writing**.
  - **`--run`** (a non-interactive consent flag) is required to execute; even then, each command is printed before it
    runs and the result is logged to `notes.md`. NO interactive prompt inside the shell (brittle across agents/CI/
    non-TTY) — a flag only.
  - The SKILL instructs the agent to pass `--run` ONLY after the user authorized the displayed command(s) (or the
    prompt clearly says to run that spec's verification).

## Intent

Give the `sdd` plugin the back half of the spec lifecycle as two on-demand subcommands:

- **`/sdd verify <spec>`** — re-run a spec's declared `**Verify:** \`<cmd>\`` command(s) to prove the spec's mechanical
  claim still holds, logging a timestamped pass/fail block to `notes.md`. Preview-by-default; `--run` to execute.
- **`/sdd close [<spec>]`** — a read-only auditor that reports where a SHIPPED spec's artifacts disagree with its
  declared status (unchecked tasks / acceptance boxes, surviving `{{placeholders}}`, missing `**Closure:**`). Defaults
  to sweeping all shipped specs.

"Done" is the `sdd` plugin at `1.2.0` shipping the two bundled scripts + the two wired subcommands, adapted to the
Tachyon trust model (the `--run` consent gate, target containment), runtime-neutral (claude + codex), validator-free,
and with no origin-harness references in the shipped code.

## Acceptance criteria

- [x] **Scenario: close sweeps shipped specs read-only**
  - **Given** a workspace with `docs/specs/*` (some shipped with closure debt)
  - **When** `/sdd close` runs with no target
  - **Then** it audits only `shipped`/`shipped-partial` specs, reports each finding (tasks-unchecked / acceptance-
    unchecked / placeholders / missing-closure), writes nothing, and exits 1 on findings / 0 clean
- [x] **Scenario: verify is preview-by-default**
  - **Given** a spec declaring `**Verify:** \`<cmd>\``
  - **When** `/sdd verify <spec>` runs WITHOUT `--run`
  - **Then** it prints the resolved spec path + the extracted command(s) and exits WITHOUT running them or touching
    `notes.md`
- [x] **Scenario: verify --run executes + logs**
  - **Given** the same spec
  - **When** `/sdd verify <spec> --run` runs
  - **Then** each command is printed and executed from the repo root, a `## Verification log` block is appended to
    `notes.md`, and the exit code reflects pass(0)/fail(1); a spec with no `**Verify:**` declaration exits 2 and does
    not touch `notes.md`
- [x] **Scenario: target containment**
  - **Given** a target path outside `<root>/docs/specs/*`
  - **When** either subcommand is invoked against it
  - **Then** it is rejected (usage error) — never runs/audits a random directory's markdown
- [x] runtime-neutral: the SKILL references "this skill's `scripts/` dir", NOT a hardcoded `.claude/skills/...` path;
      runtimes stay `claude` + `codex`
- [x] `sdd-close --json` output is properly JSON-escaped (not raw string concatenation); `--json` works without `jq`
- [x] no origin-harness names / rule paths / origin spec numbers in the shipped scripts or SKILL
- [x] plugin version `1.2.0`; the `**Verify:**` / `**Status:** shipped|shipped-partial` / `**Closure:**` contract is
      documented in SKILL.md; small COMMENTED hints (no live placeholder lines) seeded in the templates
- [x] both codex duetos folded (design — this; impl — post-build); headless dogfood green; spec closed with `**Closure:**`

## Non-goals

- The AUTOMATIC post-edit "advisory nag" form (needs a Tachyon post-edit-validator framework — deliberately not built).
- Migrating the rest of the origin validator family (lint/typecheck/multi-stack advisories).
- An interactive shell prompt for consent (a non-interactive `--run` flag instead).
- Changing the existing authoring subcommands (`new`/`refine`/`debate`/`plan`/`tasks`/`list`).

## Open questions

_All resolved by the 2026-06-29 design dueto — see § Design decisions._

- **OQ1 — execute-a-command security.** RESOLVED → preview-by-default + `--run` consent flag (the DECISION above).
- **OQ2 — close default target.** RESOLVED → all-shipped sweep + optional specific spec (D5).
- **OQ3 — template hints.** RESOLVED → small COMMENTED hints, no live placeholder lines (avoid false positives /
  accidental execution).

## Context / references

- The source scripts (markdown+shell, runtime-neutral): the origin harness's `spec-verify.sh` (a spec's `**Verify:**`
  command runner, logs to notes.md) + `sdd-close.sh` (read-only shipped-spec closure auditor).
- The `sdd` plugin (`tachyon-plugins/sdd`) — manifest + the authoring SKILL + 4 templates + `scripts/new.sh` (the
  bundled-script invocation pattern this mirrors).
- The 2026-06-29 codex design dueto (in the planning workspace's codex-exec runtime-state).
