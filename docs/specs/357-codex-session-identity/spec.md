# 357 — codex-session-identity

_Created 2026-07-05._

**Status:** shipped
**Closure:** shipped 2026-07-05 (commit c47fcc5, 0.55.31). Every codex agent spawns into a lifetime-scoped
private CODEX_HOME (materializeHomeOnly made default for codex; seedCodexHomeOnlyConfig now symlinks auth.json
too, fixing the 401 the T0 spike found); rollouts are physically isolated → the activity resurrection
(t-8f2f5b) is impossible at the runtime-rollout source, and resume/attribution scope to the private home
(closes the t-ff6429 session-id gap). Design was resolved by an empirical T0 spike (codex respects
CODEX_HOME — dissolving the dueto's 3 blockers) rather than the racy resolve-then-lock the draft proposed.
Verified: full suite 2643 green + a LIVE auth test (private home authenticates + isolates) + HUMAN DOGFOOD on
the installed 0.55.31 (maintainer: new codex starts with EMPTY activity; codex-2 migrated to a private home
and authenticates normally). Follow-up left open: the delegation-as-system t-ee7d5f captured the "green is
not correct" lesson this spec taught.

## Intent

A CLASS of bugs shares one root: **codex (a capture runtime) has no stable per-INSTANCE session identity, so
Tachyon resolves its session by CWD → newest transcript — ambiguous when instances share a folder.**
Manifestations: **t-8f2f5b** (activity resurrection — a fresh codex attaches a prior codex's rollout on
start), **t-ff6429** (attribution lost, `resume.sessionId:""`), **t-2d3580** (MCP tools staleness).

Claude escapes because it MINTS a uuid per session AND Tachyon matches the EXACT session via `title`/
customTitle (spec 220) — so a shared cwd is safe. Codex has no exact self-correlator, so Tachyon scans by
cwd and takes the newest rollout. Spec 351 covered the SECURITY identity (caller); this covers the
RUNTIME-SESSION identity (which rollout/transcript belongs to THIS instance).

**The design pivot (dueto 55ef12d7, all 3 blockers): "resolve-then-lock by cwd/newest" is fundamentally
broken and is FORBIDDEN as the authoritative binding.** Post-start "newest in cwd" can crystallize the WRONG
session (turning an ambiguous read into a persistent error), and two codex starting concurrently in one cwd
can each grab the other's rollout. Exact per-instance binding requires ONE of:
- **(P) a private per-instance transcript namespace assigned BEFORE spawn** — physically separate rollout
  storage per instance, so cwd can never collide (this is what `isolate: transcript` SHOULD do, made the
  default for codex); OR
- **(C) a Tachyon-injected per-instance correlator persisted into the codex rollout** — a tag/title/session
  marker we set at spawn and match exactly (a codex analog of claude's customTitle), IF codex supports one.

If NEITHER (P) nor (C) is available, default-mode exact binding is IMPOSSIBLE and Tachyon MUST **fail closed**
(leave the runtime unbound / show empty-but-honest activity) — it must NOT approximate with cwd/newest.

## Prerequisite spike (T0 — gates the whole design; dueto blocker 3 + finding 8/10)

Before any implementation, VERIFY empirically (spawn real codex with redirected HOME/XDG under each mode and
inspect the filesystem — the probe could not, and the spec must not assume):
- Where does codex actually write its rollout/session files, and by what key?
- Does codex RESPECT a redirected HOME / XDG / a session-root override, or does it always write to the real
  `~/.codex/sessions/`? (Determines whether (P)/`isolate:transcript` can isolate at all.)
- Does codex expose ANY settable+persisted per-instance tag/title/session-id we could inject+match for (C)?
- On resume, does codex APPEND to the same rollout, create a successor rollout with an explicit parent, or
  create an UNLINKED new rollout? (Determines the resume binding rule.)
The spike's answers pick (P) vs (C) vs fail-closed. **If codex ignores the redirect AND exposes no
correlator, the honest outcome is: default shared-home codex cannot be exactly bound without upstream codex
support — Tachyon fails closed there and the supported path becomes a private namespace we fully control.**

## The three configurations this MUST cover (maintainer requirement)

1. **Default** (no `isolate`/harness): shared home + cwd — where the bug lives. Fix = give it (P) or (C), or
   fail closed. Do NOT ship a cwd/newest approximation that merely masks the race.
2. **`isolate: "transcript"`** (spec 240 — own session namespace, same folder): the intended (P). The spike
   MUST prove codex rollouts land in the private root; if any rollout is written to the real
   `~/.codex/sessions/`, this mode is NOT isolated and is marked unsupported/fail-closed until a real
   session-root override exists.
3. **Isolated harness** (spec 226/…): private `configHome`; resolution scoped there. Same filesystem proof.

## Acceptance criteria

- [ ] **Binding evidence rule** (dueto finding 7 — the core normative rule)
  - A codex rollout may be bound to an instance ONLY if it (a) carries a Tachyon-injected per-instance
    marker, OR (b) lives under a per-instance transcript root exclusively assigned to that instance BEFORE
    spawn, OR (c) is a codex-exposed session id captured for that spawn. **cwd, mtime, "newest" ordering,
    process start-time windows, and agent name are INSUFFICIENT as sole evidence.**
- [ ] **Scenario: new same-named codex, same folder, starts clean** (t-8f2f5b repro)
  - codex A ran + removed; codex B (same name/folder, default) starts → B's Activity is EMPTY, attribution
    is B's own session — achieved via (P)/(C), never via cwd/newest.
- [ ] **Scenario: concurrent start is deterministic** (dueto blocker 2)
  - Two codex panes start in the same cwd/home within one scheduling window → each binds to a DISTINCT
    self-correlating session, OR stays unbound/fail-closed until an exact self-correlating session appears.
    It must NEVER bind either pane to the other's rollout.
- [ ] **Scenario: fail-closed over wrong-bind** (dueto blocker 1 + finding 8)
  - When no (P)/(C) evidence exists, resolution returns unbound/ambiguous (honest empty activity) — never
    "newest by cwd". A wrong persistent lock is worse than no lock.
- [ ] **Scenario: session-owners keyed per instance** (dueto finding 6)
  - session-owners rows are keyed by a stable Tachyon runtime-INSTANCE id + bound codex session id — NOT by
    display name/cwd. Removal deletes ONLY that instance's rows; it never deletes rows of other LIVE panes
    sharing cwd/name (test: same-name concurrent panes + remove one). And session-owners is only an ALLOWLIST
    after an exact binding exists — it MUST NOT be used to CHOOSE among candidate rollouts (dueto finding 5).
- [ ] **Scenario: resume binding is explicit** (dueto finding 4/9)
  - On resume, Tachyon binds only if codex appended to the locked rollout OR created a successor rollout with
    an explicit parent/resume link to it. An UNLINKED new rollout → allocate a NEW binding and record the
    transition; never fall back to cwd/newest. `resume.sessionId` becomes non-empty ONLY after exact binding
    evidence succeeds, and equals the session THIS pane created/resumed — asserted in tests.
- [ ] **Scenario: isolate/harness filesystem proof** (dueto finding 10)
  - For each mode, tests assert the ACTUAL rollout path codexNormalizer reads. In isolate/harness, NO
    candidate from the user's real `~/.codex/sessions/` may participate; all candidates come from the
    expected configHome/session root.
- [ ] **Scenario: removal closes BOTH sources** (coherent with t-d3f62b/t-123143)
  - Removing a codex instance clears its bound-session record + name-keyed activity `.jsonl` + its
    per-instance session-owners rows — a reused name cannot resolve back to it.

## Non-goals

- Not changing claude's model (mints uuid + title-match already). Not new cryptographic identity (351 owns
  caller identity; this is runtime-session). Not re-doing t-2d3580 (list_changed shipped) — but note MCP
  session-identity overlap. No auto-migration of existing rollouts.

## Open questions (mostly resolved into the T0 spike)

- (P) vs (C) vs fail-closed is DECIDED BY THE SPIKE, not assumed. The maintainer wants the default fixed —
  but "fixed" may mean "codex default always runs in a Tachyon-controlled private transcript namespace"
  (making P the default), IF the spike proves codex respects the redirect. If not, the honest deliverable is
  fail-closed default + a documented path to a private namespace / upstream codex support.


## T0 SPIKE — RESOLVED (claude, empirical, 2026-07-05)

Ran `CODEX_HOME=/tmp/codexspike codex exec "..."` and inspected the filesystem:
- **Codex RESPECTS `CODEX_HOME` for the session root** — the rollout was written to
  `/tmp/codexspike/sessions/2026/07/05/rollout-<ts>-<uuid>.jsonl`; NOTHING leaked to the real
  `~/.codex/sessions/`. **(P) private per-instance namespace IS viable.** The dueto's blocker-3 fear (codex
  ignores the redirect) is REFUTED empirically.
- Each codex rollout already carries a per-session **uuid** in its filename — so once storage is physically
  isolated per instance, the "which rollout is mine" question is trivial (there is exactly one).
- **Auth gap found:** the redirected home hit a 401 (no `auth.json`). Tachyon's existing
  `HarnessManager.seedCodexHomeOnlyConfig` copies `config.toml` but NOT `auth.json` — so isolate:transcript
  codex likely fails auth today (latent bug). The private home MUST carry `auth.json` too (copy or symlink).

**This DISSOLVES the dueto's 3 blockers:** with physical per-instance isolation there is no resolve-then-lock
race (blocker 1), no concurrent-cwd collision (blocker 2 — each instance has its OWN home), and isolation is
PROVEN not assumed (blocker 3). The design no longer needs (C) correlator or fail-closed as the primary path.

## RESOLVED DESIGN (supersedes the P-vs-C-vs-fail-closed framing above)

**Every codex agent instance runs in a private `CODEX_HOME` keyed to the agent's LIFETIME, so its rollouts
are physically isolated — cwd collision (and thus resurrection/mis-attribution) becomes impossible.**
- The private home is created when the agent is created, PERSISTS across stop/resume (so resume re-binds to
  its OWN rollout), and is DESTROYED on removal. A reused name AFTER removal gets a FRESH home → clean start
  (closes the resurrection loop t-8f2f5b at the SECOND source, complementing t-d3f62b at the first).
- The home carries `config.toml` AND `auth.json` (fix the seed gap) so codex authenticates; `<home>/sessions`
  is private; the workspace project cwd/config still loads (this is exactly the spec-240 `isolate:transcript`
  shape — the fix makes it the DEFAULT for codex, auto-provisioned, not an opt-in flag).
- `resolveCaptureSession`/`resolveCaptureId` for codex scope to the instance's private `CODEX_HOME` — there is
  exactly one rollout there, so "newest by cwd" ambiguity is gone; `resume.sessionId` gets the real uuid
  (fixes t-ff6429) and equals THIS instance's session.
- The three modes unify: default = auto private home (sessions-isolated, auth/config carried); isolate =
  same + the seed-auth fix; harness = same + private MCP/skills. All read only from their own `CODEX_HOME`.

**Coherence with removal cleanup:** agent removal now also deletes the private `CODEX_HOME` (alongside
name-keyed activity t-d3f62b + session-owners rows t-123143) — one lifecycle, all state cleared.
