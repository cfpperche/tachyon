# 287 — plugin-install-ux

_Created 2026-06-28._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

Two install-UX gaps surfaced live-dogfooding the transcribe plugin (spec 286), which provisions a 148 MB data
artifact (the ggml model) and declares two external tools (whisper-cli, ffmpeg):

1. **No download progress (pin p-0e9619).** While the model downloads, the consent drawer shows a generic "busy" and
   the page looks **frozen** for the whole 148 MB. `applyInstall → provisionData → downloadToTemp` streams with a byte
   cap but emits NO progress to the webview.
2. **Missing external tools vanish after install (pin p-1c7c95).** A plugin's external-tool requirements + their
   present/missing status are shown ONLY inside the install consent drawer, and the "Install in terminal" assisted-
   install button disappears when the drawer closes. After install, a missing whisper-cli/ffmpeg is silently ✗ with
   NO surfaced path to resolve it.

"Done": (1) the install busy state shows live download progress ("Downloading model… 42 / 148 MB") instead of looking
frozen; (2) an installed plugin's card shows its external tools with present/missing + a persistent "Install in
terminal" affordance for the missing ones, so the user is guided to the (separate, consent-gated) assisted install
without re-opening the consent drawer.

**Deliberate NON-changes (the design decision behind gap 2, recorded so it isn't re-litigated):** installing a plugin
does NOT block on missing external tools and does NOT auto-install them. The plugin install ≠ the system-tool install:
the data the engine owns (the model) IS provisioned; the system binaries are the user's (they may already have them, or
install later; whisper-cli isn't package-installable on Linux so blocking would make the plugin uninstallable). The
assisted install runs the package manager AS ROOT with the user's password — a deliberately SEPARATE, explicit,
consent-gated action, never bundled silently into a plugin install. This spec only makes that separate action
**discoverable after install** + adds **progress feedback** — it does NOT change the install gate.

## Acceptance criteria

- [ ] **Scenario: live download progress**
  - **Given** an install provisioning a large data artifact (or tool)
  - **When** the download runs
  - **Then** the webview busy state updates with bytes/total ("Downloading <name>… NN / MM MB"), not a frozen generic busy
- [ ] download progress flows through a real channel: `downloadToTemp` emits `onProgress(downloaded, total)`,
      threaded through `provisionData`/`provisionTools` → `applyInstall` → the panel → a webview busy/progress message
- [ ] **Scenario: missing external tools on the installed card**
  - **Given** an installed plugin that declares external tools, one of which is absent
  - **When** the Plugins view renders its card
  - **Then** the card shows each external tool present/missing, with an "Install in terminal" action for a missing one
- [ ] **Scenario: assisted install from the installed card**
  - **Given** a missing external tool on an installed plugin's card
  - **When** the user clicks "Install in terminal"
  - **Then** the same consent-gated, OS-auth, argv-normalized assisted install runs (resolved from the LOCKFILE's
    recorded requirement, not a pending consent op) — identical security to the drawer path
- [ ] the install GATE is unchanged: a missing external tool never blocks the plugin install + is never auto-installed
- [ ] detection cost on the installed cards is bounded (presence resolution, not a per-refresh heavy probe storm)

## Non-goals

- Changing the install gate (no blocking, no auto-install — see § Intent).
- A pixel progress BAR is optional; a live byte/percent busy LABEL satisfies the acceptance.
- Per-file progress for many small payload files (the concern is the large pinned data/tool download).
- Re-architecting the consent drawer.

## Open questions

- **OQ1 — progress granularity.** A busy LABEL updated with bytes/total (cheap, no new message type) vs a structured
  progress message + a bar. Lean: a throttled busy-label update (e.g. on each ~1 MB or ~250 ms) — minimal, no drawer
  rework.
- **OQ2 — installed-card detection cost.** Running `detectExternalTool` (which may execFile a `--help` probe) for every
  external tool of every installed plugin on every refresh is a process-spawn storm. Lean: the card uses a
  PRESENCE-ONLY check (clean-PATH resolve + trust, NO probe) — cheap; the full probe stays in the install preview.
- **OQ3 — the installed-card assisted-install action.** It must resolve the requirement from the LOCKFILE entry (not a
  pending consent op like the drawer path). Reuse `buildAssistedInstall(req.install)` + the same modal/terminal/guard/
  in-flight machinery. Confirm the lockfile `externalTools` req carries enough (it carries name + install argv map +
  manual).
- **OQ4 — re-detect after the terminal closes.** After an assisted install finishes, the card should re-detect (the
  existing `onDidCloseTerminal → io.post()` already refreshes; confirm the card re-renders present/missing).

## Context / references

- spec 284 (data artifacts) — `downloadToTemp`/`provisionData` is where progress originates.
- spec 285 (external-tool requirements) — `detectExternalTool`/`buildAssistedInstall`/`installExternalOp` (the drawer
  assisted install to generalize to the installed card); the lockfile `externalTools` req.
- spec 270 (configurable plugins) — the installed-plugin card (Config/Docs buttons) is the surface to extend.
- The pins: p-0e9619 (progress), p-1c7c95 (missing-dep surfacing) — both from the spec-286 transcribe dogfood.
