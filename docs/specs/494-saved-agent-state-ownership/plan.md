# 494 — saved-agent-state-ownership — plan

_Drafted from `spec.md` on 2026-08-06. The approach, not the steps (those go in `tasks.md`)._

## Approach

The work has four parts. They are ordered by risk. Part 1 fixes a live p0 and does not depend
on the other three. Deliver it first, and deliver it alone if the rest is deferred.

### Part 1 — finish the split that `t-0ad300` started

`config.agents` answers two questions today. `agentSources` already answers one of them.
`t-0ad300` added `mode: "refused"` so a refused agent keeps a roster row, and
`Workspace.ts:5224` already treats `refused` as a member for the purpose of blocking spawns:

```ts
// t-0ad300 — `refused` joins `profile` here. A refused agent now has a roster row, so for the
// first time there is a surface that could try to start it
.filter(([, source]) => source.mode === "profile" || source.mode === "refused")
```

So membership already has a map. Three doors were never moved onto it. Move them.

`isAgentProfileAgent` (`Workspace.ts:4106`) asks a runnability question:

```ts
return asAgent(this.config?.agents[name])?.profileLifecycle !== undefined;
```

It has exactly three call sites, all measured, all removal doors: `Workspace.ts:2099`
(`inspectSavedAgentProfile`, the Bridge proposal path), `4125` (`planAgentProfileForget`) and
`4195` (`forgetAgentProfileAgentCascade`). Replace it at those three sites with a membership
question over `agentSources`, which admits `mode: "profile"` and `mode: "refused"` alike.

The forget plan must then stop reading `config.agents` for its own facts.
`Workspace.ts:4170` reads:

```ts
locatorPresent: this.config?.agents[name] !== undefined,
```

Measured in `evidence/measurement-2026-08-06.md`, that reports `false` for a refused agent
whose roster row exists. Read the roster instead. This is the trap the evidence names: a fix
that only removes the guard produces a plan that leaves the row behind.

Nothing else in the plan needs a projection. `planAgentProfileForget` already gathers its
facts from disk, from the ledger, from `probeAgentOccupancy` and from the authority port. The
one input it took from `config.agents` is the locator, and the locator has its own owner.

### Part 2 — the local roster document

Create `.tachyon/roster.json`. Reuse `t-aaad95`'s store, which is already written and already
tested: `src/config/globalSettings.ts` holds the shape of the discipline this spec needs —
schema version, fail-closed parse, last-known-good on refusal, temp plus rename, and a
`stat`-based staleness check instead of a watcher. Its header states each rule.

Do not reuse the FILE. `~/.tachyon/settings.json` is machine-global and a roster is
per-workspace. Keying a global file by workspace path would repeat the defect the measurement
found: `workspaceHash` is `sha256(path)`, so a renamed checkout loses its own entry.
`.tachyon/` is inside the workspace, is ignored by Git, and already holds the profiles and the
transaction journal. It is the same house, not a third one.

Shape, minimal:

```json
{
  "schemaVersion": 1,
  "agents": {
    "claude": { "origin": "local", "profile": ".tachyon/agents/claude/agent.yml" }
  }
}
```

`origin` is the bridge to teams and it costs one field. Today the only legal value is `local`.
A future shared roster adds entries with another origin and merges them. Because `origin` is
written from the first version, that later change is additive. No entry has to be rewritten,
so the expansion the owner asked for stays possible without a destructive migration.

### Part 3 — the migration

Run it when `.tachyon/roster.json` is absent and `tachyon.yml` declares `agents`.

1. Read the `agents` section of `tachyon.yml`.
2. Refuse the whole migration if any entry cannot be read. Write nothing.
3. Write `.tachyon/roster.json` with every entry, `origin: local`, through temp plus rename.
4. Leave `tachyon.yml` unmodified.
5. Report what was written.

Idempotence comes from step 0, not from a marker file: the roster document IS the marker. A
second run finds it and stops. Duplication is impossible because the roster is a map keyed by
agent name, not a list.

The migration does not touch the authority, and that is the property that makes it safe. The
authority registry is keyed by agent NAME inside a secret keyed by `wsHash`
(`agentProfileAuthority.ts`, `operationalStateKeys.ts:23`). Neither key mentions where the
roster lives. Moving the roster therefore cannot strand an attestation.

Leaving `tachyon.yml` unmodified is deliberate. A migration that deletes the old copy before
the new one is proven turns a bad write into a lost fleet. The residue is reported and the
human deletes it. This is the first open question in `spec.md`.

### Part 4 — naming the disagreement

Derive the five states from four presence facts: roster row, profile directory, authority
record, successful projection. Compute them on load. Store nothing.

The state rides two surfaces that already have readers. It gets no surface of its own.

## Named consumers

`spec.md` requires a consumer that exists today for every mechanism. Each one, named.

| Mechanism | Consumer that exists today | Where |
|---|---|---|
| Membership over `agentSources` | `planAgentProfileForget`, `forgetAgentProfileAgentCascade`, `inspectSavedAgentProfile` | `Workspace.ts:2099,4125,4195` |
| Forget plan for an inconsistent agent | `ForgetPlanView`, which renders per-step state and already has a `refused` arm | `src/webview/agent-studio-shell/ForgetPlanView.tsx` |
| `.tachyon/roster.json` | the config loader, which reads the roster on every load | `agentProfileConfigLoader.ts`, via `Workspace.parseTrustedConfigText` (`Workspace.ts:5215`) |
| Roster refusal and last-known-good | the config failure surface already rendered on the sidebar | `ConfigFailure` / `degradedRosterExtras` / `configInvalid`, `sidebarFleetService.ts:177` |
| Disagreement state string | the sidebar row's existing `refused` field, which `list_agents` also returns | `sidebarFleetService.ts:250`, `runtime-api/sidebarProjection.ts:124` |
| Roster reconciliation on demand | an agent diagnosing a fleet problem through the Bridge | new tool beside `reconcile_worktrees` (`src/bridge/tools/worktrees.ts:244`) |
| Migration report | the same config failure surface as the roster refusal | as above |
| Forget transaction journal | a human or agent doing forensics after a failure | `.tachyon/canonical-agent-transactions/forget/` |

Two of those consumers deserve an honest note.

**The Bridge reconciler has a real reader, and today's session is the proof.** Diagnosing
`claude23` needed the roster, the profile directory, the transaction journal, the loader
source and `~/.claude/settings.json`. `list_agents` returned the refusal string and nothing
about which owners disagreed. An agent asked that question today and had to answer it by
reading five sources. That is the consumer.

**The transaction journal's reader is rare, and the spec does not pretend otherwise.** Nobody
opens `forget/*/journal.json` routinely. It was read once today, during this diagnosis, and
it answered a question no other record could: `claude23` left no entry, so the transaction was
never reached. A record that is read only after a failure is still worth writing. It is not
worth a surface.

**No standing reconciliation report is proposed.** There is no human who opens one. The
human's two surfaces are the sidebar row and the forget dialogue, and both already exist. A
report nobody opens is work for nobody, and `t-f353bc` asked for that to be said out loud
rather than designed around.

## Key decisions

- **Membership moves onto `agentSources`, not onto a new map** — chosen because `t-0ad300`
  already built it, already gave it a `refused` mode, and `Workspace.ts:5224` already reads it
  as membership; rejected adding a parallel roster map because two maps is the defect this
  spec exists to remove.
- **The roster lives in `.tachyon/roster.json`, not in `~/.tachyon/settings.json`** — chosen
  because a roster is per-workspace and `.tachyon/` already holds the profiles and the
  journal; rejected the global file because keying it by workspace path reproduces the
  rename-breaks-everything defect the measurement found in `wsHash`.
- **`origin` ships in v1 with one legal value** — chosen because it makes a shared roster
  additive later; rejected omitting it because adding a discriminator to a populated document
  later is exactly the destructive migration the owner's constraint forbids.
- **The migration leaves `tachyon.yml` untouched** — chosen because the old copy is the only
  recovery path if the new write is wrong; rejected deleting the section because a failed
  migration would then lose the fleet, and `t-f353bc` states migration must not lose an agent.
- **Removal never requires a repair first** — chosen because the product created the state and
  must be able to undo it; rejected "authorize `bypassPermissions`, then forget" because it
  forces a human to grant an authority they are trying to delete.
- **Runnability is derived and never stored** — chosen because its inputs include a host file
  no Tachyon record owns; rejected caching the last known projection because a stale "runnable"
  is the failure mode that costs more than a recomputation.
- **The five states get no surface of their own** — chosen because both readers already exist;
  rejected a reconciliation panel because no human was found who would open it.

## Files touched

| File | Change |
|---|---|
| `src/workspace/Workspace.ts` | membership question replaces `isAgentProfileAgent` at three call sites; `locatorPresent` reads the roster |
| `src/config/agentProfileConfigLoader.ts` | membership comes from the roster document; `tachyon.yml agents` becomes a migration source only |
| `src/config/roster.ts` (new) | the roster document: schema, fail-closed parse, last-known-good, temp plus rename |
| `src/config/rosterMigration.ts` (new) | the idempotent `tachyon.yml` to `.tachyon/roster.json` migration and its report |
| `src/config/agentForgetPlan.ts` | the plan admits an agent with no successful projection |
| `src/config/loadConfig.ts` | `tachyon.yml` schema drops `agents` and keeps `settings` |
| `src/sidebar/sidebarFleetService.ts` | the existing `refused` string carries the disagreement state |
| `src/bridge/tools/fleet.ts` | the on-demand roster reconciliation tool |
| `tachyon.yml.example` | NOT touched here. Its inline agents are a separate defect. |

## Risks & unknowns

- **The three `isAgentProfileAgent` call sites are the ones measured, not necessarily all the
  doors.** `t-e73e54` and `t-17d885` are in `docs/project-guidance.md` because a second caller
  arrives later. Enumerate the actors and triggers that can reach removal before writing the
  test, and make that enumeration the test-case list. The five rows in the evidence table are
  the starting point, and the hand edit of `tachyon.yml` is one of them.
- **Prove the guard red.** Write the failing test against `claude23`'s exact shape before the
  fix. `repro.ts` in the evidence already produces the byte-identical refusal without touching
  SecretStorage, so the fixture is cheap and does not need the extension host.
- **`parseProfileAwareConfigSyntax` has a second caller** at
  `ClientWorkspaceStudioTarget.ts:634`, on the editor side, and it stubs profiles on purpose.
  Moving membership out of `tachyon.yml` changes what that syntax pass sees. Check it before
  changing the schema.
- **Removing `agents` from the `tachyon.yml` schema is the one irreversible step.** A workspace
  that loads a new build and then downgrades finds a roster the old build cannot read. Consider
  making the old section readable-but-ignored for one release rather than rejected.
- **The disagreement state string is human-facing.** It goes through `vscode.l10n.t(...)` and
  the bundles, per `docs/project-guidance.md`.

## Visual impact

Two surfaces change, and both already exist.

The sidebar row's refusal text gains the disagreement state. The row is already rendered for a
refused agent, so the risk is length: a state name plus the spec 471 refusal string is long,
and the measured string is already 260 characters. Check that the row does not collapse at 360
as well as 880, per `docs/project-guidance.md`.

The forget dialogue changes from a permanent pending state to a rendered plan. The anchor,
written before the build: **a human who opens Forget on a broken agent sees, within one
screen, what will be removed and what is already gone, and never sees a spinner that does not
resolve.** Capture both widths.

**Visual QA Opt-Out:** not claimed. This spec is a design; the evidence is captured by the
implementing task.

## Sources consulted

- `evidence/measurement-2026-08-06.md` — this spec's own measurement, taken first.
- `src/config/agentProfileConfigLoader.ts:140-182` — the refuse-and-delete path.
- `src/workspace/Workspace.ts:2099,4106,4124-4175,4194-4199,5215,5224` — the removal doors.
- `src/webview/agent-studio-shell/ForgetPlanView.tsx:55` — the pending state of `t-02e72c`.
- `src/cockpit/agentStudioDomain.ts:166-177` — where the throw becomes an error, not a plan.
- `src/config/globalSettings.ts:1-13` — the `t-aaad95` store discipline this spec reuses.
- `src/config/agentProfileAuthority.ts`, `src/workspace/operationalStateKeys.ts:23` — the
  authority key, which the migration must not disturb.
- `src/tmux/TmuxService.ts:330` — `workspaceHash`, which is why a rename breaks the authority.
- `docs/specs/471-claude-bypass-permissions-optin/spec.md` — shipped, and the reason
  `claude23`'s refusal is correct.
- `docs/project-guidance.md` — actor by trigger, prove the guard red, two widths.
- `t-f353bc` and its stated owner decision of 2026-08-06.
