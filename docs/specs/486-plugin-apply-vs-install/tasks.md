# 486 — plugin-apply-vs-install — tasks

_Generated from `plan.md` on 2026-08-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

Two phases after the scope cut. A is the point; B is forced by A — once install
materializes nothing, the delegated toolkit breaks unless its source moves.

**Sequencing against SDD 485:** A5's UI lands in `src/webview/plugins/App.tsx`, which D2 has already
moved to a standalone app. Confirm that merge is in before writing it, or it lands in the file that
no longer renders.

## Implementation

### Phase A — applied-state exists, and install stops materializing

- [ ] A1. Measure first, and write the answer in `notes.md`: what does each runtime do when a skill
      directory disappears **mid-session**? Un-applying while an agent runs is a real sequence and no
      runtime's behaviour there has been measured. If a runtime crashes or wedges rather than losing
      one skill, that changes what A5's switch may offer — so this comes before the switch exists,
      not after.
- [ ] A2. Add the applied record, LOCAL by decision (`spec.md` — Tachyon state does not travel in the
      repo; the exceptions are re-opened by name). Its own store, not a field on `plugins.lock.json`:
      that file records what was FETCHED, and its `integrity.payload` deliberately drifts once a human
      edits (spec 270). One file must not answer two questions with two lifetimes.
- [ ] A3. `install` writes the payload and materializes NOTHING. Materialization moves behind
      `apply(plugin, skill)`, fanning out to every runtime the plugin declares.
- [ ] A4. `unapply(plugin, skill)` removes exactly what `apply` wrote — the lockfile's `targets`
      already name those paths per runtime, so it is a lookup, not a guess — and leaves the payload
      alone, so re-applying needs no refetch.
- [ ] A5. Per-skill apply/un-apply control on the Plugins app. The state the model introduces has no
      representation today: **installed but not applied**. A card that renders it as absent would hide
      a plugin the human installed — that is the visual failure to design against.

### Phase B — the delegated toolkit reads the payload

- [ ] B1. `AgentManager`'s delegated toolkit captures from `.tachyon/plugins/<plugin>/`, not from
      `target.file`. Source change only: the runtime filter (`AgentManager.ts:1238`), the per-name
      withholding on capture failure (`t-b505b3`) and the digest-conflict refusal (`t-b0cfd4`) all
      stay exactly as they are — measured, not assumed.
- [ ] B2. Delegation works with **zero** skills applied. That is the phase's whole test: today the
      workspace materialization is the source, and after A it is usually absent.

## Verification

_Each maps to a checkbox in `spec.md` § Acceptance criteria._

- [ ] Installing a plugin materializes nothing in any runtime's project directory (A3)
- [ ] Applying one skill materializes exactly that skill, into every runtime the plugin declares (A3)
- [ ] Un-applying removes the materialization from every runtime dir and leaves the payload (A4)
- [ ] A Temporary agent gets its own worktree and receives the parent's skills filtered by runtime,
      with any shortfall named (B1 — the filter and the naming already exist; prove they survive)
- [ ] A canonical Grok agent is creatable with plugins installed and nothing applied (A3)
- [ ] Applied-state survives a reload: an un-applied skill does not resurrect (A2)
- [ ] Delegation works with zero skills applied (B2)

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** the delivered behaviour is a human toggling a skill into and out of a workspace
and an agent's capability set changing as a result — the acts are a click and a spawn, and neither is
observable headlessly in a way that proves the product rather than the fixture. The mechanical half
is covered by `**Verify:**` (materialization on apply, removal on un-apply, reload survival,
delegation with nothing applied); the human half is below.

**Human dogfood:**
1. Install a plugin that ships skills. Confirm no runtime project directory gained anything.
2. Apply one skill. Confirm it appears for every runtime the plugin declares.
3. Create a canonical Grok agent. It works, and the inspector has nothing to forgive.
4. Un-apply the skill while an agent is running. Behaviour matches what A1 measured — no surprises,
   because the surprise was measured first.
5. Reload the window. The un-applied skill stays un-applied.

## Visual QA

Phase A5 is the only visible surface this spec still owns after the cut, and it introduces a state
that has no representation today: **installed but not applied**. Measured at 880 and 360 with the
browser viewport AND `?width=` set together — `plugins.css` carries a `@media (max-width: 720px)`
that a frame-only resize never fires (`t-b24282`), and D2's own pass proved the trap is live on this
exact screen.

- [ ] Evidence:
- [ ] Verdict:

## Cookbook

**Cookbook:** yes
<!-- Applying and un-applying a plugin skill is a new operator act with a fail-closed rule worth
     stating once: an un-applied skill is not uninstalled, and a running agent may already hold it.
     One page: when to apply, when to un-apply, what a Temporary child inherits, and what a reload
     does. -->
