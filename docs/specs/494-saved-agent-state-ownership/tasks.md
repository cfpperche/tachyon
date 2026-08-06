# 494 — saved-agent-state-ownership — tasks

_Generated from `plan.md` on 2026-08-06. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

The four parts are ordered by risk. Part 1 removes a live p0 and depends on nothing else.
Ship Part 1 alone if the rest is deferred.

## Part 0 — prove the guard red

- [ ] Enumerate every actor and trigger that can reach removal of a Saved Agent. Start from the
      five rows in `evidence/measurement-2026-08-06.md` and add any door found since. Make that
      list the test-case list, named the same way.
- [ ] Add a fixture that builds a refused canonical agent without SecretStorage. Port
      `repro.ts` from the evidence: two Claude agents, a private fake home, one with
      `authorize: [bypassPermissions]` and one without.
- [ ] Write the failing test. Assert that a forget plan is computed for the refused agent, and
      that `remove-locator` reports `will-run`. Watch it FAIL before any fix.
- [ ] Write the failing test for the Bridge door. Assert that
      `propose_saved_agent_removal` accepts the refused agent. Watch it FAIL.

## Part 1 — membership and runnability stop sharing one map

- [ ] Add a membership predicate over `agentSources`. It admits `mode: "profile"` and
      `mode: "refused"`. It must not read `config.agents`.
- [ ] Replace `isAgentProfileAgent` with it at `Workspace.ts:2099`, `4125` and `4195`.
- [ ] Change `locatorPresent` at `Workspace.ts:4170` to read the roster, not `config.agents`.
      This is the trap the evidence names. Cover it with its own assertion.
- [ ] Make `planAgentProfileForget` compute every step without a successful projection. Confirm
      each remaining input comes from disk, the ledger, the occupancy probe or the authority
      port.
- [ ] Confirm `forgetAgentProfileAgentCascade` completes for a refused agent, and writes a
      journal entry under `.tachyon/canonical-agent-transactions/forget/`.
- [ ] Run the Part 0 tests. They must pass now, and the enumeration must have no uncovered door.

## Part 2 — the roster document

- [ ] Create `src/config/roster.ts`. Follow `src/config/globalSettings.ts`: `schemaVersion`,
      fail-closed parse, last-known-good on refusal, temp plus rename, `stat`-based staleness.
- [ ] Define the entry shape with an explicit `origin`. Accept only `local` in this version, and
      refuse any other value by name.
- [ ] Read membership from the roster in `agentProfileConfigLoader.ts`.
- [ ] Report a refused roster through the existing `ConfigFailure` surface. Never fail silently.
- [ ] Check `parseProfileAwareConfigSyntax`'s second caller at
      `ClientWorkspaceStudioTarget.ts:634` before changing what the syntax pass sees.

## Part 3 — the migration

- [ ] Create `src/config/rosterMigration.ts`. Run only when `.tachyon/roster.json` is absent and
      `tachyon.yml` declares `agents`.
- [ ] Refuse the whole migration if any entry cannot be read. Write nothing on refusal.
- [ ] Write every entry with `origin: local`, through temp plus rename.
- [ ] Leave `tachyon.yml` unmodified. Report the residual `agents` section to the human.
- [ ] Assert the migration reads no SecretStorage key for writing, so no attestation changes.
- [ ] Run the migration twice against this workspace's three agents. Assert the second run
      writes nothing, duplicates nothing and reports that it had already run.
- [ ] Decide the first open question in `spec.md` before removing `agents` from the
      `tachyon.yml` schema. Consider one release of readable-but-ignored.

## Part 4 — naming the disagreement

- [ ] Derive the five states from the four presence facts. Store nothing.
- [ ] Carry the state on the existing `refused` string of the sidebar row. Localize it with
      `vscode.l10n.t(...)` and update the bundles.
- [ ] Add the on-demand roster reconciliation tool beside `reconcile_worktree_hygiene`. It
      answers, per agent: membership, the four owner facts, the derived state, and the door that
      would remove it.
- [ ] Resolve the third open question. Enumerate the doors that could create
      `unlisted-profile`. If none exists, make its handling a refusal to act.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Every acceptance scenario in `spec.md` has a test named after it.
- [ ] `claude23` is removed through Agent Studio, end to end, on this machine. It is the
      acceptance fixture. Do not delete it by hand before this step.
- [ ] A roster copied to a new path leaves `verify`, `projectGuidance`, `maxAgents` and `auth`
      in effect. Re-run the `probe.ts` measurement from the evidence to confirm.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood -- --list`
<!-- Placeholder target. The implementing task must add a scenario that forgets an agent in
     each of the five disagreement states, using an existing harness. Replace this line with
     that scenario's name. Do not add a one-off package script. -->

**Human dogfood:** open Agent Studio on `claude23`, press Forget, and confirm the plan renders
instead of staying on "Computing what this will do…". Then complete the forget and reload.

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

Anchor, written before the build: **a human who opens Forget on a broken agent sees, within
one screen, what will be removed and what is already gone, and never sees a spinner that does
not resolve.** Measure the forget dialogue and the sidebar row at 880 and at 360. The sidebar
row is the shared surface, so capture a neighbour row that this spec does not change and anchor
on not regressing it.

- [ ] Evidence:
- [ ] Verdict:

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <494>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook:** yes
<!-- Part 4 adds a Bridge tool. An operator needs to know when to ask it, what the five states
     mean, and which door removes each one. Add cookbook.md when Part 4 ships. -->
