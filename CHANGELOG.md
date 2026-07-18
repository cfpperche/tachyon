# Changelog

All notable changes to Tachyon are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Older history lives in the git log and the
Marketplace release notes.

## Unreleased

## 0.56.29 — Durable pane transcripts (t-6a6a00)

### Added
- **Per-agent `pipe-pane` transcripts** under `.tachyon/pane-transcripts/`
  (0700/0600). Survives kill-session/reload; read path always strips ANSI and
  runs `redactSecrets`.

## 0.56.28 — Persistent control peer auth (t-faa36e)

### Security
- **Engine control socket** requires a per-daemon 0600 nonce sidecar with
  timing-safe verification before request dispatch (dir perms no longer sole
  auth boundary).

## 0.56.27 — Drop stale queued notify after sender death (t-99ccc9)

### Fixed
- **`notify_agent` queue no longer injects obsolete completion lines** after the
  sender is killed. Sender incarnation metadata is bound into the existing
  NoticeQueue stale-source guard (minimal fix, not a full notification redesign).

## 0.56.26 — Hermetic verify path budget (t-b3ca7e)

### Fixed
- **`verify_task` full suite under deep temp clones.** Shorten clone parent to
  `tv-<12hex>`, set `TMUX_TMPDIR`, and keep restart dogfood sockets short so
  AF_UNIX paths stay under ~108 bytes. DaemonStateStore permission test now
  chmod-forces group bits under restrictive umask.

## 0.56.25 — Requester cancel for pending human approvals

### Added
- **`cancel_human_approval` Bridge tool** (`t-ae89d1`).
  Authenticated requesters can withdraw their own still-pending approval as
  `status=cancelled` with an audit reason — no false Deny, no stale Accept,
  no approve-text injection. Host resolve refuses cancelled records.

## 0.56.24 — Reentrant worktree path lock (prune deadlock)

### Fixed
- **Worktree path mutex is reentrant for nested same-path ops** (`t-3fb6eb`).
  `DeliveryProjectionService.prune` holds the path lock then calls `remove`, which
  re-enters the same mutex; the previous non-reentrant chain deadlocked, hung
  Bridge prune/reconcile for 300s, and leaked projection claims.

## 0.56.23 — Governed projection reconcile Bridge tool

### Added
- **`git_delivery_reconcile` Bridge tool** (`t-608f2e`). Linked GitDeliveries with
  `projectionSync=pending` can now drain pending canonical projection intents through a
  caller-authorized path (requires integrate + prune principal rights) before integrate/prune.

## 0.56.22 — Projection intent atomicity + corrupt-quarantine abandon

### Fixed
- **GitDelivery projection ops no longer orphan `projection.intent` events on guard failure** (`t-b3242a`).
  Prune eligibility is assessed before appending a canonical intent; unapplied prune intents that still fail
  guards can be voided by reconcile; `projectionSync` reports `pending` when the canonical intent log is ahead
  of `lastAppliedProjectionSequence`.
- **Approval-only `abandon_without_worktree` works for quarantines with a corrupt holder boundary** (`t-832946`).
  Missing `executionNonce` / mismatched holder no longer leaves a permanent no-exit quarantine; held leases
  still fail closed without process death proof.

### Changed
- **Solo hermes development fleet** may list `hermes` under `gitDelivery.integratePrincipals` /
  `prunePrincipals` so the local coordinator can close linked GitDelivery records without other agents.

## 0.45.1 — Catch a mistyped plugin-root placeholder

### Fixed
- **The install consent now warns when a plugin's hook references a mistyped plugin-root placeholder.** A hook
  command that uses `${PLUGIN_ROOT}` (or any `${…PLUGIN…ROOT…}` token that isn't the real `${TACHYON_PLUGIN_ROOT}`)
  is never substituted — it expands to *empty* at runtime, silently running `/<script>` ("not found") so the hook
  never fires. The Plugins drawer now surfaces a non-blocking warning ("did you mean `${TACHYON_PLUGIN_ROOT}`?")
  before you install, so the footgun is caught at consent time instead of failing quietly in a live agent.

## 0.45.0 — Plugins can enforce a tool's safety flags

### Added
- **A plugin can force a provisioned tool to always launch with mandated safety flags.** A tool declaration may
  carry a `launchPolicy { env, args, denyArgs }` that the Tachyon launcher **always** applies — it force-sets
  env vars (overriding a hostile parent env), prepends forced args, and **refuses** an agent argument that would
  override a policy-controlled flag (fail closed). The forced policy is shown in the install consent and bound
  into its fingerprint, so you approve exactly what the tool will always run with; a corrupt policy refuses the
  lockfile rather than launching the tool unpoliced. Loader/exec-hijacking env (`LD_*`/`DYLD_*`/`PATH`/
  `NODE_OPTIONS`/…) is rejected. The guarantee is **"enforced via the launcher"** — a same-user agent that
  re-executes the raw binary outside the launcher is out of scope (that needs agent sandboxing, not file perms).
- **First consumer — the `agent-browser` plugin's form-driving write gate (2.0.0).** Browsing the web with an
  agent now holds every *common* state-mutating action (click/fill/type/submit/upload/eval/download) for an
  explicit confirmation instead of running it silently; reads stay frictionless, and the gate-disable surfaces
  (`--confirm-actions`/`--action-policy`/`--config`/`mcp`/`batch`) are refused. A best-effort mechanical hold
  plus a human-approval protocol — not a sandbox (see the plugin's README for the honest scope).

## 0.44.0 — Plugins discover newer published versions

### Added
- **"Check updates" now finds a newer release of a tag-pinned plugin.** A plugin pinned to a semver tag
  (`github:org/repo@v0.5.0`) used to re-resolve its *exact* immutable pin, so it was forever "up to date" even
  after the source repo published a higher tag. Tachyon now also resolves the repo's **highest semver tag** and,
  when it is newer, evaluates the update against it — surfacing the available version and, on your confirm,
  re-pinning the lockfile to that **higher immutable tag** (reproducibility preserved: it never floats to a
  moving "latest"). The plugin's own manifest version still decides whether an update actually exists, so a
  monorepo tag bump that didn't touch *this* plugin correctly stays "up to date". Branch / `HEAD` / SHA /
  non-semver pins are unchanged, and a failed tag lookup falls back to the exact-pin check (never regresses a
  healthy "up to date"). A pin to a semver-*shaped branch* is never mistaken for a tag.

## 0.43.1 — No false "nothing to wire" warning for skills-only plugins

### Fixed
- **A skills-only (or MCP-only) plugin no longer shows a misleading "declares X but carries no hooks — nothing
  to wire" warning per runtime.** The install preview checked only for a hooks block, so a portable-skill plugin
  like `sdd` warned for every declared runtime even though each one *does* receive the skill. The warning now
  fires only when a runtime materializes **nothing** for the plugin (no hooks, no skill, no MCP) — a genuinely
  pointless declaration. The install behavior was always correct; only the alarming-but-wrong message is gone.

## 0.43.0 — Plugins provision their own pinned tools

### Added
- **A plugin can declare per-platform pinned CLI tools that Tachyon fetches, verifies, and runs.** This is what
  makes a git-hook gate (0.42.0) fail *closed* meaningfully — e.g. a secrets scanner's binary is now reliably
  present. The author pins `{url, sha256}` per platform (libc-qualified: glibc/musl); Tachyon downloads over
  HTTPS-only with bounded redirects, checksum-verifies the bytes, and atomically installs the executable into an
  immutable, content-addressed `.tachyon/bin/<name>/<binSha256>/<tool>` (`O_EXCL`, `0500`, `0700` parents). A
  mismatch fails closed — the bytes are discarded, never executed. tar.gz/tgz archives are unwrapped with a
  metadata-first, single-file extractor that rejects traversal/symlink/zip-bomb tricks.
- **A dedicated, stronger-than-MCP consent.** The Plugins drawer shows each tool's resolved platform, declared +
  final URL, checksum, and publisher, behind its own acknowledgement — with language making clear the sha256
  proves **integrity against the manifest, not that the publisher is trustworthy**.
- **A re-validating launcher.** A git-hook leaf references a tool via `${tool:<name>}`, which resolves to a
  plugin-scoped `_tachyon-tool` invocation; the launcher re-validates the binary's hash (and ownership/mode)
  against the lockfile before *every* exec — so a swapped binary never runs. Uninstall deletes a tool's bytes
  only when no other plugin references them; a fresh clone (where `.tachyon/bin` is gitignored) rehydrates the
  tools explicitly from the lockfile — never a silent fetch.

## 0.42.1 — Git-hook plugins need no runtime

### Fixed
- **A pure git-hook plugin no longer has to declare a runtime.** A git hook runs on every commit regardless of
  which agent runtime you use — it is runtime-agnostic — so requiring a `claude`/`codex` declaration was a
  vestige that produced a confusing "declares X but carries no hooks" notice. A git-hook-only plugin now
  declares no runtime and installs cleanly with no phantom runtime row or warning. (A skill/MCP capability still
  needs a runtime to install into.)

## 0.42.0 — Plugins can install git hooks

### Added
- **A plugin can now install a git `pre-commit` hook** — a gate that runs on **every commit, for every actor**
  (you, the agent, your IDE), not just when an agent acts. This is what makes a real secrets-scan (or any
  commit-time gate) possible. Because `core.hooksPath` is single-owner, Tachyon installs a **chaining
  dispatcher**: your existing hook runs first, then each plugin's hook, and the commit is blocked if any fails —
  multiple plugins and your own hook coexist. The consent drawer shows the exact command with a dedicated
  "runs on every commit" acknowledgement (it can read staged content and block commits; `git commit --no-verify`
  bypasses it). Removing the plugin restores your prior hook setup exactly and never touches your own hook.
- **Repair hooks** (header button) re-activates git-hooks after a clone whose `.git/config` didn't carry over.

### Internal
- Worktree-correct hook/config resolution (`git rev-parse --git-path`/`--git-common-dir`); a content-addressed
  leaf store + integrity-checked execution manifest + repo-level ownership refcount under a repo lock;
  transactional install (`core.hooksPath` set last) with a fingerprint binding the hook state; the engine
  install/remove/update path is now async. Linux/WSL/macOS only. Spec 264; suite + tsc ×2 + webview build green.

## 0.41.2 — Remove drawer counts skills & MCP

### Fixed
- **The Remove confirmation now shows everything it will delete, not just hooks.** Uninstalling a skills-only
  plugin previously showed "0 hook groups removed" — as if nothing would happen — even though it removes the
  skills, the committed payload, and any empty folders the install created. The drawer now lists **skills
  removed** / **MCP servers removed** / **hook groups removed** (each when applicable) plus orphans kept, with a
  note that the payload and installer-created empty directories are removed too.

## 0.41.1 — Plugin card pill fix

### Fixed
- **An installed plugin's runtime pill now reflects what's actually on disk.** A skills-only plugin installs its
  codex skills into `.agents/skills/` and never creates a `.codex/` folder, so the card wrongly showed `codex —`
  ("not present") even though codex *was* installed. The pill now checks the plugin's recorded materialization
  (its lockfile targets) — so it reads `codex ✓` when the skill is on disk, and only shows `—` as a genuine
  drift signal when a runtime's installed files were deleted out from under the plugin.

## 0.41.0 — Plugins install into a fresh workspace

### Changed
- **Installing a plugin no longer requires the runtime's folder to already exist.** Before, a plugin that
  declared `runtimes: [claude, codex]` would silently materialize **nothing** in a clean repo that had no
  `.claude/`/`.codex/` directory — the consent drawer showed each runtime as "skipped (not present)" and the
  install was a green no-op. Now the **plugin author** decides which runtimes a plugin targets and the
  **installer** agrees in the consent drawer: each declared runtime is a selector row labelled **present** or
  **will be created**, and Install creates whatever structure the selected runtimes need. Deselecting every
  runtime disables Install (never a payload-only no-op).
- **Uninstall cleans up exactly what it created.** The lockfile now records the runtime directories an install
  created (and only those), so removing a plugin removes the dirs it made — never a folder that pre-existed or
  that still holds your own files.
- **Updates keep your original runtime selection.** An update materializes into the same runtimes you consented
  to at install (not whatever happens to be on disk now); if a new version drops a runtime you installed into,
  the update refuses with a clear error instead of silently dropping it.

### Internal
- `previewInstall`/`applyInstall` take the consented **target** runtime set (not `detectRuntimes`-as-gate); the
  selection is bound explicitly into the consent fingerprint; `createdAncestors` is recorded before activation
  (so a partial install still has a complete removal record) and `atomicWrite` cleans its temp on failure.
  Spec 263; full suite + tsc ×2 + webview build green.

## 0.38.0 — Leaner coordination surface

### Changed
- **Retired the free-form shared notes whiteboard.** Tachyon had three overlapping ways to coordinate —
  **pins** (a structured checklist), **notes** (a free-form `.tachyon/notes.md` blob), and the **project
  handoff** (curated state). Notes is gone: discrete findings go to **pins**, narrative coordination state goes
  to the **project handoff** (which is append-safe and distilled — the wholesale `set_notes` overwrite was a
  multi-agent footgun), and a long result belongs in a file or is read with `read_output`. Existing
  `.tachyon/notes.md` files are left on disk untouched; the `get_notes`/`set_notes` Bridge tools and the
  "Open Notes" command are removed.
- **Simpler sidebar sort.** The Agents / Terminals sort is now just **A–Z ⇄ Z–A** — one click on the header
  control flips the direction (the old three-way menu and the live "status" reorder are gone), with a clearer
  sort icon.

### Internal
- Pins and the project handoff are untouched; the Bridge tool count drops from 28 to 26. No behavior change to
  anything that survived; tsc ×2 + engine-boundary + the full suite stay green.

## 0.37.0 — One consistent webview look

### Changed
- **Every Tachyon panel now shares one design system.** The six webviews — the sidebar, Activity, Project
  Handoff, Plugins, Agent Studio, and the tmux Server Inspector — had each grown their own styling, so the same
  element (a panel title, a badge, a button) drifted from panel to panel; titles alone ranged from 16px to 30px.
  They now draw from a single shared stylesheet: one type scale (a **16px panel title everywhere**), one spacing
  rhythm, and **identical badges / buttons / cards / inputs** across every panel.
- **The look follows your VS Code theme.** Every color is driven by your theme's own variables, so the panels
  adapt to whatever you run — **light, dark, or high-contrast** — instead of a hardcoded palette that could fight
  a light theme. Vertical spacing was tightened onto a consistent grid for a calmer, more even layout.

### Internal
- A single theme-driven `design-system.css` (`.ds-*` tokens + components) is copied to `dist/webview/` and
  linked by every webview; each panel keeps only its genuinely panel-specific styling (no re-defined tokens).
  Added a headless render harness that screenshots each panel under both a dark and a light theme. No behavior
  change; tsc ×2 + engine-boundary + the full suite stay green.

## 0.36.0 — Plugin skills

### Added
- **Plugins can now ship skills, not just hooks.** A plugin includes a `skills/<name>/SKILL.md` payload (written
  once), and Tachyon installs it into every present runtime that loads skills — **Claude** (`.claude/skills/`)
  and **Codex** (`.agents/skills/`), the same `SKILL.md` format for both. Skills install, update, and remove
  through the same Plugins View as hooks.
- **Your own skills are never silently overwritten.** When a plugin's skill would land where you already have a
  skill of that name, the consent drawer surfaces the collision with a **Keep mine / Replace** choice — Keep is
  the default, and **Replace requires a second explicit confirmation** (it permanently overwrites; there's no
  undo). Remove deletes exactly the skill-dirs Tachyon wrote, never your own.

### Internal
- Plugin engine extended to a second capability with a fail-closed security posture: the skill loader rejects
  symlink-escapes / oversized payloads / YAML-bomb frontmatter; install/remove are consent-fingerprint-bound
  (TOCTOU); and every lockfile skill-dir path is validated against the runtime's skills dir before it is ever
  trusted or deleted, so a corrupted lockfile can't turn a remove into an arbitrary delete.

## 0.35.0 — Plugins

### Added
- **The Plugins View — manage plugins from a new editor panel.** Open it from the **Plugins** button in the
  sidebar title bar (next to Inspect tmux). Per workspace, you can browse what's installed, install a plugin
  by its git source (`github:owner/repo@ref`), update, reinstall, and remove. Each plugin's native config
  block is merged into every runtime present in the workspace (claude + codex in v1; gemini is deferred).
- **A blocking security consent drawer before anything is written.** Installing, updating, or removing first
  shows the source provenance (resolved commit + integrity hash), the **full list of shell commands** the
  plugin will run on agent events, every file Tachyon will write, and a consent fingerprint. The apply is
  **bound to exactly what you consented to** — it refuses if the workspace or source moved since the preview,
  so a remote plugin's hooks are never wired silently or swapped out from under you.

### Internal
- Plugin engine completed end to end: a git source resolver + fetcher with a content-addressed cache,
  provenance + integrity pinned in the lockfile for byte-reproducible re-hydration, and a pure view-model
  layer (list + consent) so the UI's logic is unit-tested rather than buried in the VS Code layer.

## 0.34.3 — clearer Activity reminders

### Fixed
- **Tachyon's injected reminders no longer masquerade as human messages.** A `[tachyon] …` nudge (the
  handoff/continuity reminders Tachyon types into a pane) was rendering as a human chat bubble in the
  Activity feed, indistinguishable from what you typed. It now renders as a subtle, centered system chip
  (the agent still receives the reminder unchanged — this is purely how the feed reads).

### Internal
- Plugin system (engine, not yet surfaced in the UI): added a 3-way plugin updater that updates an
  installed plugin without clobbering your edits — it refuses (without force) when you've edited or would
  duplicate a plugin's hooks, and force-gates a downgrade.

## 0.34.2 — one cleanup path for agent teardown

### Fixed
- **Deleting a configured agent no longer orphans its activity log.** The 0.34.0/0.34.1 fixes cleaned the
  durable `.tachyon/activity/<agent>.jsonl` for ad-hoc kill, dismissal, and pipeline-node teardown, but the
  "Delete" action on a declared agent removed its config entry + session row while leaving the log behind —
  the same orphan class, just on the declared-delete path. Deleting an agent now drops its log with its row.

### Changed
- **Internal:** the "remove an ephemeral agent's session row + activity log" pair, previously open-coded at
  every teardown site (and the source of the drift that left orphans), is centralized into one shared,
  idempotent cleanup helper, so a future teardown path can't silently re-introduce an orphan. No behavior
  change for the existing kill/dismiss/pipeline paths.

## 0.34.1 — activity log also cleaned on kill

### Fixed
- **Killing an ad-hoc agent no longer leaves an orphaned activity log.** 0.34.0's cleanup (an agent's durable
  `.tachyon/activity/<agent>.jsonl` dies with its ledger row) covered dismissal and pipeline-node teardown but
  missed `kill` — which removes the row and, unlike a clean-exit dead pane, leaves no pane to view the log from,
  so the log was left unreachable on disk. Killing a non-persistent ad-hoc agent now deletes its log with the
  row. Found in live dogfood of 0.34.0.

## 0.34.0 — Delegation contract on agent-spawned AI sub-agents

### Added
- **When an agent delegates to a fresh AI sub-agent through the Bridge, it must now hand it a structured brief.**
  `spawn_agent` for an ad-hoc AI child requires a contract — **task + context + constraints + (deliverable OR
  done_when)** — or the call is rejected with a message naming what's missing, so the agent fixes it and retries.
  The accepted contract is composed into the child's opening instructions (it IS the child's brief, not just a
  checkpoint) and persisted with the agent. A genuinely trivial spawn can opt out with `skip_contract_reason`
  (≥10 chars), which is recorded and surfaced to you rather than silently allowed. Terminal (non-AI) children and
  agents declared in `tachyon.yml` are not gated. Enforced at the Bridge, so it works the same for any runtime
  (claude / codex / gemini / opencode); restarting, resuming, or forking an existing agent is never re-gated.

### Fixed / changed
- **A finished one-shot or pipeline `cmd:` node no longer leaves an orphaned, unreachable activity log.** The
  durable `.tachyon/activity/<agent>.jsonl` now shares the agent's lifecycle — it's removed when the agent is
  dismissed (a clean-exit ad-hoc) or its inline pipeline node is torn down, instead of accumulating on disk with
  no row to view it from. A declared agent keeps its log; the postmortem "Activity" view of a dead pane is
  unaffected (the log is dropped only at dismissal).
- **Launcher-wrapped AI commands (`npx claude`, `env -u VAR claude`, …) are now classified and prompted
  consistently** — a single resolver sees through `npx`/`bunx`/`env` for both kind-detection and prompt
  delivery, so a wrapped AI agent both gets gated and actually receives its brief.

## 0.33.0 — Project Handoff: agent-driven distill

### Added
- **An agent can now DISTILL the pending notes into the handoff — you just curate.** Reading the handoff
  (`get_project_handoff`) now returns the pending notes themselves (not just a count) plus a watermark, so an
  agent can fold them into a rewritten handoff, show you the draft, and on your OK write it
  (`set_project_handoff`). You stay the curator (approve / ask for changes); the agent does the typing.

### Fixed / changed
- **A note appended while a distill is in flight is never silently lost.** Pending is now tracked by an explicit
  distill watermark (which notes have actually been folded in), not by wall-clock — so a note that lands between
  an agent reading the handoff and writing the distilled version simply stays pending for the next pass. A plain
  rewrite (without declaring a distill) no longer clears pending — clearing is now an explicit, deliberate step.

## 0.32.1 — Project Handoff: quieter, smarter append-nudge

### Fixed
- **The "append a handoff note" reminder no longer nags an agent that has nothing new to log.** It now fires only
  when an agent has done real new work since it was last reminded or last appended (a per-agent activity-lag gate),
  on top of the existing per-workspace interval (`settings.handoff.nudgeEvery`). An agent that just logged — or
  that judged its recent work not worth a project note — won't be re-reminded for the same work.

## 0.32.0 — Project Handoff (shared state of the work)

### Added
- **A Project Handoff: one shared, curated "state of the work" per workspace — distinct from per-agent
  continuity.** Where per-agent continuity recovers an individual agent's thread, the handoff is the project-level
  picture (current state / active work / next actions / decisions & gotchas) that any human or freshly-resumed
  agent can read. Two lanes keep it correct in a multi-agent workspace without write conflicts:
  - **Canonical** `.tachyon/HANDOFF.md` — human/owner-curated, git-tracked, edited as a whole (concurrency-safe
    via compare-and-swap so a stale rewrite can't clobber a newer one).
  - **Pending notes** `.tachyon/handoff-notes.jsonl` — any agent appends a structured note (completed / blocked /
    decision / gotcha / next); the owner distills them into the canonical. Agents never rewrite the shared file.
  - **New Bridge tools:** `get_project_handoff`, `append_project_handoff_note`, `set_project_handoff`.
  - **A read-only editor panel** opens from a per-folder button in the sidebar (with a staleness badge: Fresh /
    Needs distill · N / Possibly stale / Old), rendering the handoff + the pending notes.
  - **A light, opt-out nudge** reminds an idle agent to append a note when project state changed — throttled
    per-workspace via `settings.handoff.nudgeEvery` (default `30m`, set `off` to disable). The handoff path is
    overridable via `settings.handoff.path`.

## 0.31.2 — Resume reopens the current session after `/clear` (shared cwd)

### Fixed
- **Stop→resume now reopens the session you were actually in, even after a `/clear` on a shared folder.** 0.31.1
  made the Activity feed *follow* a `/clear`; this completes the loop for *resuming*. Before, resuming a Claude
  agent that shared a folder with others could reopen the **pre-`/clear`** conversation, because the stored
  session id was never advanced past the rotation. Tachyon now uses the same per-agent ownership ledger (0.31.1)
  to pick the resume target — at stop, at resume, and for the sidebar's resumable badge — so it reopens the
  current session and never another agent's. Agents that manage their own session (`claude --resume …`) and
  non-Claude runtimes are unchanged; agents started before 0.31.1 keep the prior behavior until their next start.

## 0.31.1 — Activity keeps logging after `/clear` (shared cwd)

### Fixed
- **The Activity feed no longer freezes after `/clear` (or an in-TUI `/resume`) when several Claude agents share
  one folder.** Previously, once an agent's session id was captured, a `/clear` rotated Claude to a brand-new
  session that — on a shared working directory — Tachyon couldn't attribute from disk (Claude discards the
  Tachyon-set title and writes no parent link), so the durable Activity log stayed pinned to the old, frozen
  transcript and silently stopped recording. Tachyon now spawns each Claude agent with a per-spawn `--settings`
  `SessionStart` hook that records which session belongs to which agent in a small ledger
  (`.tachyon/activity/session-owners.jsonl`); the Activity view follows that **positive** signal, so it tracks a
  rotation exactly — and can never attribute another agent's session to the wrong log. No `~/.claude` or repo
  `.claude/` settings are touched (the `--settings` layer is additive, so your own hooks still run). Agents that
  manage their own session (`claude --resume …`) or already pass `--settings` are left untouched.

## 0.31.0 — Sortable sidebar (no more status churn)

### Changed
- **The Agents and Terminals lists are now a single flat list you sort yourself** — instead of bucketing into
  Running / Idle / Stopped groups that reflowed every time an agent changed state. The default is **Name (A–Z)**,
  a stable order where a status change just **recolors the dot in place** (no more rows jumping around). A sort
  control in the section header offers **Name (A–Z) · Name (Z–A) · Status (live)**; your choice is remembered.
  Status stays at-a-glance via the colored dot (hover for the label) and compact **per-status count chips** in the
  header. Other sections (Pipelines, Runbooks, Commands, Schedules, Pins) are unchanged.
  - **Note:** existing users will see Agents/Terminals switch from status-groups to a flat A–Z list by default —
    pick **Status (live)** from the new sort control to get the old status-first ordering back.

## 0.30.2 — Continuity nudges name the agent

### Fixed
- **The continuity nudge now spells out the agent's exact name in the `set_continuity` call.** An agent doesn't
  know its own Tachyon name, so when nudged it could guess wrong (e.g. write its brief under `main`) — the brief
  landed in the wrong file and its badge/recovery never saw it. Tachyon types the nudge and knows the name, so it
  now writes `set_continuity(agent: "<name>", …)` literally; the tool also warns against guessing.

## 0.30.1 — Continuity polish

### Fixed
- The continuity re-injection no longer points at `cat .tachyon/roles/<agent>.md` when that role doc doesn't
  exist (it only appears for agents you've actually re-anchored) — no more `cat` of a missing file.

## 0.30.0 — Per-agent continuity + richer diffs

### Added
- **Per-agent continuity — each agent keeps its working memory across session boundaries.** An agent now
  maintains a short continuity brief (`.tachyon/continuity/<agent>.md`: current goal, working state, decisions,
  next steps, open threads). When the agent crosses a **discontinuity** — a context compaction, a `/clear`, a
  restart, or a new session — Tachyon automatically types a "rebuild your context" pointer into the pane so the
  agent picks up where it left off, instead of starting blank. It is **hands-off for you**: the agent writes the
  brief (nudged by Tachyon when it's missing or falling behind), and Tachyon re-injects it on its own. Crucially,
  a **clean same-session resume is NOT re-injected** (no double-context). A sidebar badge shows
  fresh / **◐ stale** / **○ missing**, and `Tachyon: Re-inject Continuity` forces it on demand. claude-only in v1;
  no LLM cost (the agent authors the brief). `.tachyon/continuity/` is gitignored.
- **Richer Edit/Write diffs in the Activity view** — tool diffs now render TUI-style: a per-line gutter with old/
  new line numbers, the +/− sign, syntax-highlighted code (by file type), and green/red row backgrounds, instead
  of flat monospace text.

## 0.29.2 — Toggle isolation on an existing agent

### Fixed
- **Turning on `isolate: transcript` (or `harness:`) for an agent that already has history now takes effect on
  Restart.** Previously the agent's recorded config home was pinned to where its earlier sessions lived, so a
  restart kept looking there and the newly-isolated session showed an empty Activity view. A restart mints a
  fresh session, so it now re-homes to the current config home (old history stays where it was — a transcript
  can't be moved; resuming an existing session still uses its original home). A `claude --continue`/`--resume`
  agent, which owns its own session, still needs a delete + recreate to re-home.

## 0.29.1 — Task-list rendering + Studio isolate toggle

### Fixed
- **Markdown task lists (`- [ ]` / `- [x]`) rendered as stray empty boxes in the Activity feed.** The upstream
  task-list plugin emits malformed, space-less checkbox markup; Tachyon now renders each item as a proper
  styled checkbox glyph (read-only, matching the rest of the cockpit).

### Added
- **`Isolate transcript` checkbox in the Agent Studio.** The spec-240 per-agent transcript isolation is now a
  one-click toggle when creating/editing a claude agent (still off by default; claude-only; hidden when the
  heavier `Isolated harness` is on, which already isolates the transcript).

### Changed
- **`Open transcript` moved from the Activity header to a command.** The raw runtime `.jsonl` is a power-user /
  debug escape hatch, so it's now the `Tachyon: Open Raw Transcript` palette command (targets the active
  Activity panel) instead of a header button — the rendered, durable Activity log is the primary surface.

## 0.29.0 — Backward paging + per-agent transcript isolation

### Added
- **Load earlier activity (in-panel backward paging).** The Activity view can now reach OLDER history without
  leaving the panel — a "Load earlier activity" button grows the rendered window backward over the durable log,
  keeping your scroll position anchored on the item you were reading (no jump). Bounded (it defers to "open
  transcript" past a hard cap, so the payload stays sane).
- **`isolate: transcript` — per-agent transcript namespace (spec 240).** Declare it on a claude agent to give
  it its OWN claude config home (a separate transcript namespace) WITHOUT the heavier `harness:` MCP isolation:

  ```yaml
  agents:
    reviewer:
      cmd: claude
      isolate: transcript
  ```

  Now multiple agents that share ONE folder each get an attributable session, an in-TUI `/resume`/`/clear` that
  the Activity view follows, and their own durable activity log — while still loading the workspace project
  config (`CLAUDE.md`, `.claude/`, `.mcp.json`, which are cwd-relative) and inheriting your existing claude
  login (no re-auth). The fix for "several agents in the same folder, one shows no activity."

### Fixed
- Session attribution is now drift-safe: the config home a session was written under is persisted, so a later
  `isolate`/`harness` toggle or rename can't make Tachyon look in the wrong place; startup GC no longer reaps a
  still-referenced transcript home.

## 0.28.1 — Activity in shared folders

### Fixed
- **The Activity view was empty for agents that share a workspace folder.** When ≥2 agents run in the same
  directory (the common case), the durable-log writer was over-suppressed and captured nothing, so the cockpit
  showed "Waiting for activity…" for a working agent. It now attributes each agent's session safely by its
  captured uuid or unique title even in a shared folder (only the genuinely ambiguous, id-less case is gapped,
  with an honest notice) — so each agent's history shows correctly. No misattribution: the only ambiguous
  fallback (a bare "newest in this folder" scan) is skipped on a shared cwd.

## 0.28.0 — Durable activity history

### Added
- **The Activity view now keeps each agent's full, normalized history — durably.** A per-agent activity log
  (`.tachyon/activity/<agent>.jsonl`) is written continuously by an always-on writer, so the cockpit shows a
  complete, stitched timeline across `/clear`, `/resume`, context compaction, fresh starts and restarts —
  history that would otherwise be lost when the runtime rotates session files. The log is a normalized
  projection (not a raw clone): provenance pointers back to the source records, content-addressed copies of
  the images it renders, and it survives runtime-side pruning.
- **Session & compaction boundaries are rendered as separators.** Compaction shows "context compacted" with
  the token delta and an expandable summary; session changes show "new session" / "resumed session" /
  "restarted session" / "forked session" — labeled from Tachyon's own Start/Restart/Resume/Fork actions when
  it performs them, inferred from the transcript otherwise.
- **Rich rendering in the Activity feed** (since 0.27): markdown via markdown-it (tables, task lists, quotes),
  syntax-highlighted code blocks with copy, Mermaid diagrams, LaTeX (KaTeX), thinking blocks, tool diffs,
  inline images with click-to-zoom, a live "working…" indicator, in-feed search, and a visible "recent N of
  M" cap notice instead of silently dropping older activity.

### Changed
- The Activity panel is now a read-only subscriber to the durable log (it no longer tails the runtime
  transcript directly). Opening a long session is bounded (fast) instead of re-reading the whole file.
- Post-compaction artifacts (the continuation summary, `/`-command wrappers, local-command output) are no
  longer mis-rendered as human chat messages.

### Notes
- Per-agent history is captured from now forward; on a folder shared by ≥2 agents, session stitching is
  suppressed (an honest "history stitching limited" notice) rather than risk mis-attribution.

## 0.27.0 — New sidebar

### Changed
- **The Tachyon sidebar is now a purpose-built webview panel, replacing the native tree.** Icon tabs per
  section (Agents, Terminals, Pipelines, Schedules, Commands, Runbooks, Pins), a global `⌘K`/`Ctrl+K`
  search across the whole fleet, capability-gated per-row actions with a consistent `…` overflow menu
  (Edit in Studio / Edit YAML / Delete), multi-root folders shown together and grouped, a view toolbar
  (server inspector / refresh / settings), live state for every section, and full keyboard accessibility.
- The legacy tree is removed (the `tachyon.sidebar.legacyTree` opt-in is gone). All existing commands and
  Studios are unchanged — the panel drives the same actions.

### Added
- Per-section "new …" create buttons; Commands/Runbooks show real run state (running/passed/failed) with
  open-output and step expansion; pipelines gate Run/Cancel/Dismiss/Review by run state and auto-expand on
  start; schedules reflect paused state; an honest empty state with an "Initialize Tachyon" action.

## 0.26.0 — Zero-config Bridge

### Added
- **Every Tachyon-spawned agent reaches the MCP Bridge automatically.** Tachyon injects the
  Bridge at spawn — Claude via an additive `--mcp-config`, Codex via an additive
  `-c mcp_servers.tachyon_bridge=…`, and an isolated-harness Claude has it folded into its
  scoped (`--strict-mcp-config`) file. Injection re-runs on **spawn, restart, resume, and fork**
  (a momentarily-down Bridge self-heals on the next start), and the token never lands on the
  command line. **No `.mcp.json` / `config.toml` registration is needed** for agents Tachyon
  spawns. `Tachyon: Connect Agent Runtime` remains, now scoped to **external/manual** sessions
  you start yourself.

### Fixed
- An isolated-harness agent with `inherit: none` no longer silently loses the Bridge — it is
  always folded into the materialized strict MCP file, so the agent can still call
  `complete_node` / `write_input`.

### Changed
- Pipeline preflight now treats a Tachyon-spawned Claude node as Bridge-capable (injection
  guarantees it — no project `.mcp.json` evidence required); a node whose command disables MCP
  (`--safe-mode`) is correctly reported as unable to signal completion.

### Removed
- The discontinued **layouts** feature was retired (legacy config keys remain tolerated).

### Internal
- The engine is now decoupled from VS Code behind a host port, enforced by a CI boundary guard.
- The `Workspace` is headless-testable (`createForTest` + an in-memory host).

## 0.25.0 — Agent Pipelines, input-driven
- Input-driven pipelines: one definition becomes a reusable workflow run per issue, with agent
  personas and a handoff bus that carries context down the chain.
- Codex pipeline nodes reach the Bridge automatically via an injected `-c` override.
