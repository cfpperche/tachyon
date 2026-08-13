# 486 — plugin-apply-vs-install — tasks

_Generated from `plan.md` on 2026-08-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

Two phases after the scope cut. A is the point. B was re-measured after SDD 487 and `t-53e485`:
delegation no longer reads workspace plugin state at all, so zero applied contributions is already
the normal, closed path.

**Scope widened 2026-08-03, before ratification** (`spec.md` § "A plugin is not only skills"): Phase A
covers TWO projected kinds, not one — `skill-dir` AND `settings-hook`. The maintainer asked whether hooks
could be toggled like skills; the answer is yes, and the case is stronger, because a hook is code that RUNS
rather than text a model may read. `mcp-server` is Phase C (`t-7f52f6`), `gitHooks` are a separate
mechanism and a separate follow-up (`t-e85e0e`), and `view` is out by decision, contestable in `t-7ec4b2`.

The hook half is not a copy of the skill half, and the tasks below say where they diverge: a skill is a
DIRECTORY (un-apply is a delete), a hook is an entry MERGED into a settings file the human also edits
(un-apply is a content-based un-merge, which is why `MaterializedTarget.removal` already exists).

**Sequencing against SDD 485:** A5's UI lands in `src/webview/plugins/App.tsx`, which D2 has already
moved to a standalone app. Confirm that merge is in before writing it, or it lands in the file that
no longer renders.

## Implementation

### Phase A — applied-state exists, and install stops materializing

- [x] A1. Measure first, and write the answer in `notes.md`: what does each runtime do when a skill
      directory disappears **mid-session**? Un-applying while an agent runs is a real sequence and no
      runtime's behaviour there has been measured. If a runtime crashes or wedges rather than losing
      one skill, that changes what A5's switch may offer — so this comes before the switch exists,
      not after.
- [x] A1b. The same measurement for a HOOK, which is sharper in two ways the skill question does not
      cover. (i) The entry lives in a settings file a runtime may have read ONCE at startup, so removal
      may not take effect until restart — and a switch that promises "disarmed" while the hook still
      fires is worse than no switch. (ii) A hook may be MID-EXECUTION when its entry is removed;
      "stops firing next time" and "the running one is killed" are different products. Measure per
      runtime, and let the answer constrain what A5 is allowed to say.
- [x] A2. Add the applied record, LOCAL by decision (`spec.md` — Tachyon state does not travel in the
      repo; the exceptions are re-opened by name). Its own store, not a field on `plugins.lock.json`:
      that file records what was FETCHED, and its `integrity.payload` deliberately drifts once a human
      edits (spec 270). One file must not answer two questions with two lifetimes.
- [x] A3. `install` writes the payload and materializes NOTHING — no skill directory AND no hook entry.
      Materialization moves behind `apply(plugin, contribution)`, fanning out to every runtime the
      plugin declares. Keyed by contribution, not by plugin: a plugin shipping a skill and a hook has
      two independently applicable things, because they carry different risk and the human may well
      want one without the other.
- [x] A4. `unapply(plugin, contribution)` removes exactly what `apply` wrote and leaves the payload
      alone, so re-applying needs no refetch. **Two removals, not one.** A `skill-dir` is a directory:
      the lockfile's `targets` name the path per runtime, so it is a lookup and a delete. A
      `settings-hook` is an entry inside a file the human ALSO edits: removal must go through
      `MaterializedTarget.removal` — the adapter-owned identity that exists for exactly this
      ("content-based un-merge that survives", `lockfile.ts:36`) — and a human's own edits to that file
      must survive. Prove the second with a test that edits the settings file by hand first.
- [x] A5. Per-contribution apply/un-apply control on the Plugins app. The state the model introduces
      has no representation today: **installed but not applied**. A card that renders it as absent
      would hide a plugin the human installed — that is the visual failure to design against. And a
      hook needs more than a skill does: code that will run on the next matching event must not look
      like code that will not. Whatever A1b measured about restart-to-take-effect has to be VISIBLE
      here, not just true — a toggle that reads "off" while the hook still fires is the one outcome
      worse than having no toggle.

### Phase C — `mcp-server` enters apply/unapply (t-7f52f6)

- [x] C1. Measure whether each runtime re-reads MCP config mid-session (same discipline as A1b). Live
      reread was not completed on this host (`claude -p` not logged in); `claude mcp list` discovered
      a project `.mcp.json` server as Pending approval. Card copy stays conservative. Recorded in
      `notes.md`.
- [x] C2. Spell `mcp:<kebab>` in `AppliedStateStore` (same file, not a second store). `view` stays
      unspellable.
- [x] C3. `applyContribution` / `unapplyContribution` for `mcp`. Install records lockfile targets
      but does not write the runtime config. Un-merge uses lockfile `removal` (content-match). Human
      edits in the same file survive. Uninstall calls `forgetPlugin`.
- [x] C4. Plugins card distinguishes installed-not-applied from absent. Apply/Un-apply on the card.
      Un-apply does not claim "disarmed".

### Phase B — zero-applied delegation (re-measured after `t-53e485`)

- [x] B1 retired. Re-measurement on 2026-08-13 found that `t-53e485` had already removed both
      `target.file` and installed plugin payloads from the delegation path. The sole source is the
      parent's resolved, digest-pinned grant. Reading `.tachyon/plugins/<plugin>/` here would reopen
      the measured authority leak where children received the workspace's installed set rather than
      what their parent held. This is a superseded implementation instruction, not missing work.
- [x] B2. Delegation works with **zero** skills applied. The focused regression created an installed
      payload and lockfile with no applied-state ledger and no runtime materialization; a Codex child
      received the parent's approved snapshot in its own worktree. It was green on its first run,
      which is the required outcome when the newer product is already correct.

## Verification

_Each maps to a checkbox in `spec.md` § Acceptance criteria._

- [x] Installing a plugin materializes nothing in any runtime's project directory — no skill dir and
      no hook entry (A3)
- [x] Applying one contribution materializes exactly that one, into every runtime the plugin declares,
      leaving the plugin's other contributions unapplied (A3)
- [x] Un-applying removes the materialization from every runtime dir and leaves the payload (A4)
- [x] Un-applying a HOOK from a settings file the human edited by hand removes Tachyon's entry and
      leaves the human's edits intact (A4)
- [x] A Temporary agent gets its own worktree and receives the parent's skills filtered by runtime,
      with any shortfall named (B2 plus the existing supported-runtime/refusal checks)
- [x] A canonical Grok agent is creatable with plugins installed and nothing applied (A3)
- [x] Applied-state survives a reload: an un-applied skill does not resurrect (A2)
- [x] Delegation works with zero skills applied (B2)

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

- [x] Evidence: `.vqa/visual-qa/plugins-phaseA-880.png`, `.vqa/visual-qa/plugins-phaseA-360.png` (Tachyon evidence `ev-2026-08-12T21:04:46.412Z-6`).
- [x] Verdict: pass — installed-not-applied and armed states remain distinct and controls wrap cleanly at both widths.

## Cookbook

**Cookbook-Opt-Out:** the install/apply/un-apply operator lifecycle and fail-closed rules are already
documented in `docs/runbooks/plugins.md`; duplicating that living runbook inside the closed spec would
create two operator instructions for the same surface.
