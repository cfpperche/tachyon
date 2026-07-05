# 357 — codex-session-identity

_Created 2026-07-05._

**Status:** draft

## Intent

A CLASS of bugs shares one root: **codex (a capture runtime) has no stable per-INSTANCE session identity, so
Tachyon resolves its session by CWD → newest transcript, which is ambiguous when agents share a folder.**
Manifestations seen:
- **t-8f2f5b** (activity resurrection): a NEW codex named `codex` in `~/tachyon` starts with a FRESH CLI
  session (Context 0%), but Tachyon's Activity view immediately fills with an OLD codex's rollout — because
  `codexNormalizer` reads the codex CLI rollout (`~/.codex/sessions/…`) and `resolveCaptureSession(runtime,
  cwd)` attaches the newest rollout in that cwd, not the one THIS instance created. (Deleting Tachyon's
  name-keyed `.jsonl` — t-d3f62b — only fixed the OTHER activity source; this second source resurrects on
  session start.)
- **t-ff6429** (attribution lost): ad-hoc codex has `resume.sessionId:""` — no distinct id — so Activity
  can't be attributed.
- **t-2d3580** (tools staleness): the resident MCP session doesn't re-handshake — same "no stable session
  binding" family on the MCP side.

**Why codex and not claude:** claude MINTS a uuid per session and Tachyon matches the EXACT session via
`title`/customTitle (spec 220), so a shared cwd is safe — each claude session sees only its own
`~/.claude/projects/<cwd>/<uuid>.jsonl`. Codex is a CAPTURE runtime with no equivalent exact-match: Tachyon
scans by cwd and takes the newest rollout. The identity work of spec 351 covered the SECURITY side
(cryptographic caller identity per instance); this spec covers the **runtime-session** side (which rollout /
transcript / session belongs to THIS agent instance).

**Done looks like:** each codex agent instance is bound to the SPECIFIC codex session/rollout it created (or
resumed), captured/locked at spawn; Activity, attribution, and session resolution read only THAT session, so
a new same-named agent in the same folder starts with EMPTY activity and correct attribution — and this holds
across all THREE isolation configurations (default shared-home, `isolate: transcript`, isolated harness), not
just one.

## The three configurations this MUST cover (maintainer requirement)

1. **Default** (no `isolate`, no harness): shared config home + shared cwd. This is where the bug lives today
   (resolution by cwd → newest). The fix must give the DEFAULT mode a per-instance session binding.
2. **`isolate: "transcript"`** (spec 240 — "own session namespace, same folder"): Tachyon redirects the
   agent's config HOME so its transcripts/rollouts live in a private namespace while the same cwd/project
   config loads. Resolution must be scoped to that private home (a sibling agent's rollout must be
   unreachable). Verify this mode already isolates rollouts — and if so, whether it's the recommended
   mitigation until the default is fixed.
3. **Isolated harness** (spec 226/228/298/311): the agent's own MCP/skills/instructions/hooks in a private
   config home. Fully isolated; session resolution scoped by `configHome`. Must stay correct.

## Acceptance criteria

- [ ] **Scenario: new same-named codex in the same folder starts clean** (the t-8f2f5b repro)
  - **Given** codex A ran in `~/tachyon` and produced a rollout, then A was removed
  - **When** codex B (same name, same folder, DEFAULT mode) is created and its session starts
  - **Then** B's Activity is EMPTY (it does not attach A's rollout); B's attribution points to B's own new
    session; and this holds without requiring `isolate`/harness
- [ ] **Scenario: session id locked at spawn** (root of the fix)
  - **When** a codex agent's session starts
  - **Then** Tachyon captures the REAL codex session id/rollout that THIS instance created (resolve-then-lock
    right after start), records it as the agent's bound session (ledger `resume.sessionId` no longer `""` —
    fixes t-ff6429), and all later resolution returns ONLY that session — never "newest by cwd"
- [ ] **Scenario: ownership filter** (defense in depth, reuses t-123143)
  - **Then** capture-session resolution consults the session-owners map (now pruned on removal, t-123143):
    a rollout whose session is owned by a DIFFERENT or removed agent is never attached to this instance
- [ ] **Scenario: isolate:transcript keeps its own namespace**
  - **Given** two codex agents in the same folder, one with `isolate: "transcript"`
  - **Then** the isolated one's rollouts live in its private config home and are never cross-attached; a
    shared-home agent never sees the isolated one's session and vice-versa
- [ ] **Scenario: isolated harness stays scoped**
  - **Then** a harnessed codex resolves its session only within its private `configHome`; removal cleans its
    home's session state too
- [ ] **Scenario: resume binds to the SAME session**
  - **When** a bound codex agent is stopped and resumed
  - **Then** it re-binds to its OWN locked session (not the newest in the cwd), preserving continuity
- [ ] **Scenario: removal forgets the binding** (coherent with t-d3f62b / t-123143)
  - **When** a codex agent is removed
  - **Then** its bound-session record + name-keyed activity + session-owners rows are cleared, so a reused
    name cannot resolve back to it — closing the resurrection loop at BOTH sources

## Non-goals

- Not changing claude's session model (it already mints uuids + title-matches; leave it).
- Not a new cryptographic identity (351 owns caller identity; this is runtime-session binding — they compose
  but are distinct).
- Not fixing t-2d3580 (tools/list_changed already shipped) — but the session-binding should make the MCP
  session identity coherent; note any overlap.
- Not auto-migrating existing rollouts; the fix applies to sessions bound going forward + the removal cleanup.

## Open questions

- **How to capture the codex session id at spawn?** codex writes a rollout under `~/.codex/sessions/<date>/…`
  with a session id; Tachyon can resolve-then-lock right after start (there's already `resolveCaptureId`).
  Is there a race (rollout not yet written when we resolve)? Need a reliable "the session THIS pane just
  started" signal — analogous to claude's customTitle. Does codex support a title/tag we can set + match?
- **Is `isolate: transcript` already immune?** If yes, the interim guidance is "use isolate for codex in
  shared folders" while the default fix lands. Verify.
- **Does the ownership filter alone suffice** (without spawn-time lock), given t-123143 prunes on removal? Or
  is the lock required because a live prior session in the same cwd (not yet removed) would still be "newest"?
  (Likely the lock is required — ownership filter is defense in depth.)
