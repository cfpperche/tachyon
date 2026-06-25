# 264 — plugin-git-hook-target — notes

_Created 2026-06-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### 2026-06-25 — origin

Spec A of a two-spec arc (264 git-hook target → 265 tool/binary provisioning) decided in a design discussion: evolve the plugin system to do secrets-scan PROPERLY (real commit-time enforcement + a provisioned scanner binary) instead of a runtime-hooks-only band-aid. The maintainer rejected making secrets-scan engine-native — the plugin layer already owns the consent/lockfile/TOCTOU trust machinery, so extending it is more consistent than carving an engine exception. Linux/WSL/macOS only (no Windows). 264 ships first (the real enforcement, with a detect-and-guide fallback for the missing binary); 265 closes the fail-closed story by guaranteeing the binary is present.

### 2026-06-25 — codex spec review (NEEDS-REVISION → folded)

Adversarial codex review (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T202048Z-spec264-review/`). Verdict NEEDS-REVISION; the review was sharp and almost entirely correct — folded into `spec.md`:

- **5 BLOCKERs:** (1) `core.hooksPath` restoration races across plugins/user → repo-level ownership record `{claimedFrom, managedPath, leafRefs, generation}`, restore only on `refs==0 && current==managedPath`. (2) "last managed hook" = zero leaves across **all** events, not per-event. (3) TOCTOU fingerprint must bind the resolved prior-hook identity (kind/path/exec-bit/type/content-hash/config-scope), not just hooksPath+leaves. (4) precise **dispatcher contract** (cwd, `"$@"`, stdin, output streaming, exit aggregation, ordering) — added as its own section. (5) user-hook-before/after order is a security+compat decision → ratified user-hook-first (D3).
- **HIGHs folded:** worktree-correct path resolution via `git rev-parse --git-path`/`--git-common-dir`/`--show-toplevel` (+ `extensions.worktreeConfig` refuse/scope); untracked mode-checked managed dir with content-addressed leaves from trusted dispatchers; clone behavior (lockfile present ≠ hooksPath claimed); removal identity = pluginId+event+leafPath+contentHash+generation; missing/non-exec leaf = fail-closed; stronger dedicated consent ack (data-access + bypass + restoration); **`--no-verify` honesty** (not an absolute gate); transactional install + repo lock + `repair`; concurrency snapshot reads.
- **MEDIUM/LOW folded:** canonical-id ordering + reject dup ids; run-all-aggregate decision (D3); prior-hook exit propagated distinctly; ignore `*.sample`; symlink policy (OQ1); submodules out of scope; **v1 = pre-commit only** (defer message-arg events); manifest leaf constraints (no traversal/shell-eval); relative-hooksPath raw+resolved; dispatcher self-validates at commit; cleanup empty dirs; POSIX sh + path quoting.
- **Judgment calls (mine, not blind accept):** kept run-all-aggregate over codex's fail-fast lean (better multi-gate feedback, same blocking outcome); scoped v1 to pre-commit (simplifies several message-arg concerns at once).

### 2026-06-25 — codex review round 2 (verification → folded)

Second adversarial pass on the revised spec (transcript: Agent0 `.agent0/.runtime-state/codex-exec/20260625T*-spec264-review2/`). Round-1 BLOCKERs **B1/B2/B3/B5 confirmed CLOSED**; **B4 PARTIAL** + a residual BLOCKER. All folded into the Dispatcher contract:
- **Environment contract** (new BLOCKER): the dispatcher preserves Git's hook env exactly, adds only `TACHYON_`-namespaced vars, never scrubs/synthesizes Git env; each step inherits it.
- **argv-array exec semantics** (HIGH): direct `execve`-style spawn with the argv vector — no shell, no PATH lookup unless opted-in; cwd+env from the contract.
- **Immutable snapshot** (MEDIUM): the dispatcher reads an atomically-published snapshot that never references a missing leaf (the repair/remove-under-lock exception is the installer's, not the dispatcher's).

Architecture confirmed sound; these were operational refinements, not re-design.

## Deviations

## Tradeoffs

## Open questions
