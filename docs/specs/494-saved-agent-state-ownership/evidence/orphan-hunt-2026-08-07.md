# Orphan hunt — measurement, 2026-08-07 (`t-bbe760`)

Slice A of `t-1cb705`. The owner's decision on 2026-08-07:

> "diretório é o agente, se ficou órfão é porque existe erro de dismiss/forget/remove … vamos atrás
> das falhas até não sobrarem mais órfãos"

This file measures every origin of orphan residue in the canonical roster, in both directions:

1. a directory `.tachyon/agents/<name>/` that survives with no matching entry in `tachyon.yml#agents`;
2. an entry that survives with no directory.

It changes nothing in `src/` or `test/`. Two runnable reproductions sit beside it:

```
./node_modules/.bin/vite-node docs/specs/494-saved-agent-state-ownership/evidence/orphan-repro.ts
./node_modules/.bin/vite-node docs/specs/494-saved-agent-state-ownership/evidence/orphan-terminal-soul-repro.ts
```

Both drive production helpers in a throwaway workspace. Every transcript quoted below came from them.

## Why this blocks the switch, and is not hygiene

Today the roster is the list in `tachyon.yml`. A directory left by an interrupted forget is
INVISIBLE: nothing lists it, nothing runs it. After slice C makes the roster come from
`.tachyon/agents/`, the same directory becomes a **ghost agent in the owner's sidebar**. What is
silent garbage today becomes a visible defect. So the cost of every residue below changes on the day
of the switch, not on the day it is created.

---

## 1. The state of this machine, with numbers

Measured in the primary checkout `/home/goat/tachyon` on 2026-08-07.

| fact | value |
| --- | --- |
| directories under `.tachyon/agents/` | 2 — `claude`, `claude-cowntdown` |
| rows in `tachyon.yml#agents` | 2 — `claude`, `claude-cowntdown` |
| rows in `tachyon.yml#terminals` | 0 |
| directories with no `agents:` row | **0** |
| `agents:` rows with no directory | **0** |
| each directory's contents | `["agent.yml"]` — both |
| forget journals under `.tachyon/canonical-agent-transactions/forget/` | 23, **all `committed`**, 0 `degraded` |
| lifecycle journals under `…/lifecycle/` | 0 (the directory exists and is empty) |
| rename journals under `…/rename/` | the `rename/` directory has never been created |
| retirement receipts under `.tachyon/retired-agent-profiles/` | 24 `<agentId>/` directories |
| other checkouts carrying a `.tachyon/agents/` | none — searched every worktree under `/home/goat/.cache/tachyon/worktrees` |

**There is no orphan on this machine right now, in either direction.** The two sets are equal, not
merely the same size. This is a measurement, not an absence of measurement: the comparison is
`ls .tachyon/agents/` against the parsed `agents:` block of the live `tachyon.yml`, and the 23 forget
journals were each opened and their `phase` read.

The 24 receipts against 23 committed forgets is not a discrepancy: receipts are keyed by
`<agentId>/<txid>` and one agentId holds two txids (`grok` was forgotten more than once under
different identities).

---

## 2. Census — who can create `.tachyon/agents/<name>/`

Four modules, and no others. Found by enumerating every `path.join(…, ".tachyon", "agents", …)` and
every `` `.tachyon/agents/…` `` literal in `src/`, then reading each hit for a write.

| # | site | mechanism | governed by a journal? |
| --- | --- | --- | --- |
| C1 | `src/config/agentProfileTransactions.ts:333-351` `publishAgentProfile` | `ensureSafeDirectory` on `.tachyon`, `agents`, `<name>`, then `writeNewDurable` of `agent.yml` | yes — lifecycle journal |
| C2 | `src/agents/soul.ts:488-506` `ensureAgentProfileDir` | `mkdir` of each of the three components | yes — soul profile journal |
| C3 | `src/evolution/EvolutionStore.ts:2014` `atomicWrite` | `fs.mkdir(path.dirname(target), { recursive: true })`; for `profilePath` = `.tachyon/agents/<a>/evolution/profile.json` the **recursive create makes the parent home too** | no |
| C4 | `src/agents/formation/humanLaneTransactions.ts:233-245` `ensureProfileDirectory`, called at `:682` | `mkdirSync` of each of the three components | yes — human-lane intent |

`src/plugins/engine.ts` is **not** an origin. Its payload root deliberately excludes `.tachyon/…`
(`src/plugins/engine.ts:115`), and it materializes per-agent state under `.tachyon/harness/` and
`.tachyon/bridge-mcp/` instead. Nothing in `engine.ts` joins `.tachyon/agents`.

`src/memory/SelectedMemoryStore.ts:117-153` writes `memory/` INSIDE an existing home but cannot
create the home: `initializeDirectories` *opens* `.tachyon`, `agents` and `<agentName>`
(`:134-138`) and only `mkdir`s `memory` below them, so a missing home is an `ENOENT`, not a create.

## 3. Census — who can remove it

| # | site | what it removes |
| --- | --- | --- |
| R1 | `src/config/agentProfileForget.ts:363-378` `quarantineHome` | `fs.renameSync(source, destination)` — moves the WHOLE tree to `retired-agent-profiles/<agentId>/<txid>/`. Leaves nothing. |
| R2 | `src/config/agentProfileTransactions.ts:353-367` `removeAgentProfileIfExact` | `fs.unlinkSync(<dir>/agent.yml)` — **the file only. No `rmdir`.** |
| R3 | `src/config/agentProfileRename.ts:401-405` (roll-forward) and `:433` (compensation) | `fs.rmdirSync(oldRoot)` — and it is guarded: `:402` refuses when the directory is not empty. |
| R4 | `src/agents/forgetAgent.ts:57` | `fs.rmSync(<dir>/evolution, { recursive: true, force: true })` — **the child only. Never the parent.** |

R1 and R3 are complete. **R2 and R4 are the two places that can leave a directory behind**, and
both leave it in the one format the detector cannot classify (§7).

---

## 4. The structural asymmetry

Every governed transaction writes the directory and the roster row in a fixed order, and the order
decides which direction of orphan it can leave mid-flight.

| transaction | order | window can leave |
| --- | --- | --- |
| lifecycle **create** | home first (`agentProfileLifecycle.ts:746-747`), roster row later (`:756`) | directory without row |
| **forget** | roster row removed first (`agentProfileForget.ts:396`, phase `locator-removed`), home quarantined after (`:400`, phase `home-quarantined`) | directory without row |
| **rename** | home moved first (`agentProfileRename.ts:529`, phase `profile-moved`), locator rewritten later (`:391`) | **both at once** — the new name has a directory and no row, the old name has a row and no directory |

So **only rename can produce "row without directory" from a transaction.** Every other governed path
produces the other direction. The remaining producer of "row without directory" is a human editing
`tachyon.yml` by hand, which is the state the product already names `orphan-locator` and already
gives a door (§7).

---

## 5. Origins, one section each

Each answers the four questions the contract asks: the gesture, the exact interruption point, whether
a journal covers it and *when* it reconciles, and whether the residue is detectable today.

### O1 — a canonical create that rolled back leaves the directory. **DEFECTIVE, reproduced.**

- **Gesture.** Agent Studio → create a Saved Agent; Bridge `propose_saved_agent` after approval;
  `Workspace.commitAgentProfileLifecycle({ operation: "create" })`.
- **Interruption point.** Not a crash — an ordinary in-process failure. `commitAgentProfileLifecycle`
  publishes the home at `agentProfileLifecycle.ts:747`, then any of `publishCreateArtifacts` (`:748`),
  the authority publish (`:752-753`), the config write (`:756`), the convergence re-check (`:758-761`)
  or `activateState("target")` (`:767`) can throw. The catch at `:772-775` calls `compensate`.
- **What compensation does.** `compensate` takes the create branch at `:588-591`:
  `removeCreateArtifactsExact` then `removeAgentProfileIfExact`. The latter unlinks `agent.yml`
  (`agentProfileTransactions.ts:362`) and **never removes the directory**. The config backup at
  `:612-614` restores `tachyon.yml`, so the roster row is gone too. Then `:625`
  `fs.rmSync(txDir)` — the journal is deleted and the rollback is reported as clean.
- **Journal / reconcile.** Yes, and it is exactly the problem: the journal is *correctly* discarded
  because the rollback *did* converge on everything the journal names. The directory is not in the
  journal, so no reconcile on any later workspace open will ever look at it. This residue is
  permanent from the moment it is created.
- **Detectable today?** No. See §7 — the only sweep that reads `.tachyon/agents/` reports it as
  `absent`, "there is nothing to remove".
- **Reproduction** (`orphan-repro.ts`, ORIGIN A):

  ```
  [A] after publishAgentProfile   : ["ghost-create/","ghost-create/agent.yml"]

  --- ORIGIN A: create rolled back (removeAgentProfileIfExact) ---
    savedAgentSubjects sees (readdir)  : ["ghost-create"]
    .tachyon/agents/ghost-create/ exists    : true
    its contents                       : []
    presence facts                     : {"rosterRow":false,"profileOnDisk":false,"authorityRecord":false,"projection":false}
    deriveSavedAgentState              -> absent
    savedAgentRemovalDoor.door         -> null
    reason                             : no roster row, no profile and no authority; there is nothing to remove
  ```

### O2 — a canonical create interrupted by a crash. **Same residue, arrives at it by the other door.**

- **Gesture.** Same as O1; the interruption is a kill or a host crash between
  `agentProfileLifecycle.ts:747` and `:769`.
- **Journal / reconcile.** Covered, and it reconciles at the **next workspace open**, not merely on a
  retry in the same process: `Workspace.create` calls `reconcileAgentProfileLifecycle` at
  `src/workspace/Workspace.ts:3170`, before `reloadConfig` at `:3222`. Recovery reads the journal,
  finds the target tuple unconverged, and calls the same `compensate`.
- **Consequence.** The recovery is correct about everything it measures and lands in the same place
  as O1: `removeAgentProfileIfExact`, no `rmdir`, journal deleted, empty directory forever. Fixing R2
  fixes O1 and O2 together; they are one defect with two entrances.

### O3 — `forgetAgent` removes `evolution/` and leaves the parent home. **Mechanism DEFECTIVE and reproduced; reachability for a non-roster name UNDECIDED.**

- **Gesture.** Any end-of-life path that reaches `forgetAgent`: `AgentManager.dismissTemporary`
  (`AgentManager.ts:4092-4104` → `removeEphemeralFootprint` → `:4076`), and
  `Workspace.forgetAgent` (`Workspace.ts:4092-4099`) which the declared-agent delete uses (see O5).
- **Interruption point.** None needed. `forgetAgent.ts:57` is the *success* path:
  `fs.rmSync(.tachyon/agents/<name>/evolution, { recursive: true, force: true })`. Every other
  footprint in `FORGET_AGENT_FOOTPRINTS` is outside the profile home; this is the only line that
  reaches inside it, and it removes one child and not the parent.
- **Journal / reconcile.** None at all. `forgetAgent` is a best-effort loop of independent `attempt()`
  calls (`:43-45`) that aggregates failures at the end. No journal, no reconcile, nothing to replay.
- **Detectable today?** No — the leftover is an empty directory, §7.
- **Reproduction** (`orphan-repro.ts`, ORIGIN B): seeded the way `EvolutionStore.atomicWrite` seeds
  it, then `forgetAgent`:

  ```
  [B] after Evolution mkdir -p    : ["evolution/","evolution/profile.json"]

  --- ORIGIN B: forgetAgent after Evolution (forgetAgent.ts:57) ---
    .tachyon/agents/ghost-evolution/ exists    : true
    its contents                       : []
    deriveSavedAgentState              -> absent
    savedAgentRemovalDoor.door         -> null
  ```

- **What is NOT proved.** For this to produce an *orphan*, a home holding only `evolution/` must
  exist for a name with no `agents:` row. Two candidate producers were checked and neither closes:
  `Workspace.enableAgentSelfEvolution` (`Workspace.ts:5771-5781`) calls
  `evolutionStore.ensureProfile` — which mints the home via C3 — but it is preceded by
  `inspectAgentProfileLifecycle`, which requires a canonical profile, an authority record and a
  roster pointer (`agentProfileLifecycle.ts:434-441`), so the home already exists and the row is
  present. The spawn-time path (`evolution/startupSnapshot.ts:178`,
  `agents/formation/evolutionLane.ts:183` → `readAuthorizedActiveState`) is gated on the projection
  granting `selfEvolution`, which itself needs a canonical profile. So C3 is a real ungoverned
  `mkdir -p` of the home, and I could not show a caller that reaches it for a name outside `agents:`.
  That belongs in the undecided list, not in a task.

### O4 — Soul on a `terminals:` row publishes a home outside `agents:`. **Engine-level mechanism DEFECTIVE and reproduced; UI reachability UNDECIDED.**

- **Gesture.** Agent Studio's Soul panel → Import / Create, i.e.
  `cockpit/agentStudioDomain.ts:470-477` → `Workspace.importSoulProfileBytes`
  (`Workspace.ts:7249`); or the engine command at
  `engine-service/extensionOperationService.ts:627`. The subject is a plain `agent` string carried
  in the message; `runProfileAction` (`agentStudioDomain.ts`) applies no section check.
- **Interruption point.** None needed — this is the *success* path. Every Soul mutation gates on
  `journal.priorConfig.present` (`soulProfileTransactions.ts:589`, `:624`, `:691`, `:738`, `:766`,
  `:784`, `:814`). That token comes from `agentStanzaCasToken`
  (`config/YamlConfigEditor.ts:441-455`), whose `sectionOf` (`:36-40`) returns `"terminals"` as
  readily as `"agents"`. So a terminal passes the gate, and `publishCanonicalSoulFiles`
  (`soul.ts:874-916`) → `ensureAgentProfileDir` creates `.tachyon/agents/<terminal>/` and writes
  `SOUL.md` + `profile.json` into it. `tachyon.yml` is untouched, because
  `sanitizeForSection` (`YamlConfigEditor.ts:48-52`) strips `soul` from a `terminals:` stanza, so
  `targetConfig` equals `priorConfig` and `applyConfigSoul` (`soulProfileTransactions.ts:421-435`)
  writes the same bytes back and verifies successfully.
- **Journal / reconcile.** The soul journal covers the transaction and is discarded on success
  (`commitSuccess` → `removeTxDir`), because from its own point of view nothing went wrong. There is
  nothing to reconcile: the target tuple *is* the residue.
- **Detectable today?** No — this residue has real content (a human's `SOUL.md`) and still derives to
  `absent`, "there is nothing to remove".
- **Reproduction** (`orphan-terminal-soul-repro.ts`):

  ```
  === the gate every Soul mutation uses ===
    agentStanzaCasToken(yml, "claude" ).present = true  -> Soul create/import PROCEEDS
    agentStanzaCasToken(yml, "shell"  ).present = true  -> Soul create/import PROCEEDS
    agentStanzaCasToken(yml, "nobody" ).present = false -> Soul create/import refused (soul/path-invalid)

  === after publishCanonicalSoulFiles(ws, "shell", …) ===
    .tachyon/agents/ listing  : ["shell"]
    .tachyon/agents/shell/    : ["SOUL.md","profile.json"]
    tachyon.yml agents block  : ["claude"]  <- "shell" is not in it

    deriveSavedAgentState     -> absent
    savedAgentRemovalDoor     -> {"door":null,"reason":"no roster row, no profile and no authority; there is nothing to remove"}
  ```

- **What is NOT proved.** Whether the Studio webview ever offers the Soul panel for a name that lives
  in `terminals:`. The engine accepts it; the UI path was not measured. Also unmeasured: whether
  `t-1cb705` slice C intends a `terminals:` name to be excluded from the directory-derived roster,
  which would make this a naming collision rather than a ghost.

### O5 — the ungoverned declared-agent delete never touches the profile home. **DEFECTIVE by inspection; residue depends on O4/C3 for the home to exist.**

- **Gesture.** Delete a declared **terminal** through the sidebar / engine operation:
  `engine-service/extensionOperationService.ts:958-990` `deleteConfiguredAgent`.
- **The three branches, and why only one is governed.** At `:971` a Saved Agent member goes to
  `forgetAgentProfileAgentCascade`, which is the journaled transaction that quarantines the home
  (R1) — correct. At `:977-979` a name absent from config goes to `dismissTemporary` +
  `Workspace.forgetAgent`. At `:980-989` a declared terminal has its stanza deleted by
  `mutateConfig(deleteAgent(...))` and is then handed to `Workspace.forgetAgent` — whose own doc
  comment says *"Caller owns deleting the tachyon.yml entry first"* (`Workspace.ts:4091`) and whose
  body (`:4092-4099`) removes the ledger row, activity, harness credentials, bridge home, Pi session
  and, via `forgetAgent`, `agents/<name>/evolution`. **It never removes `.tachyon/agents/<name>/` and
  never removes `agent.yml`.**
- **Interruption point.** Between `mutateConfig` (`:985`) and `forgetAgent` (`:987`) there is no
  journal, no lock and no barrier. A crash there leaves the roster row already gone and the whole
  footprint intact. Even without a crash the home is never touched.
- **Journal / reconcile.** **None.** `reconcileAgentProfileLifecycle` / `…Renames` / `…Forgets` at
  `Workspace.ts:3170-3216` each read only their own journal directory; this door writes no journal, so
  no workspace open ever reconciles it — not at next open, not on retry.
- **Detectable today?** If `agent.yml` survives, yes: the state derives to `unlisted-profile`, which
  the product names and explains (§7 control). If the home holds Soul or Evolution bytes but no
  `agent.yml` — the O4 and C3 shapes — no.
- **This is the `t-e73e54` / `t-17d885` pattern from the project guidance, again:** one mechanism
  (quarantine the home) was built for one actor and trigger (Saved Agent forget), and a second door
  reaching the same effect skipped it.

### O6 — `degraded` is terminal for every reconcile. **DEFECTIVE by inspection; not reproduced.**

- **Gesture.** Any of the three governed transactions hitting a state-changed-under-us guard.
- **Interruption point, per transaction.** Forget: a `CustodyError` at or after phase
  `locator-removed` transitions the journal to `degraded`
  (`agentProfileForget.ts:518-520`), and by then `removeLocator` has already run (`:396`) while
  `quarantineHome` (`:400`) has not — **the roster row is gone and the home is still there.**
  Lifecycle: `compensate`'s catch writes `degraded` (`agentProfileLifecycle.ts:626-631`) after a
  create may already have published the home. Rename: `:549` and `:553` write `degraded` with the
  home at one name and the locator at the other.
- **Journal / reconcile.** The journal exists and is durable, and every reconcile **skips it
  forever**: `agentProfileForget.ts:539`, `agentProfileLifecycle.ts:803`,
  `agentProfileRename.ts:573` all `continue` on `phase === "degraded"`. Fail-closed is the right
  posture for the *agent* — but the residue is never listed and never removed.
- **Detectable today?** Partially, and only as a count. `Workspace.ts:3176`, `:3195`, `:3214` notify
  "recovery found N degraded transaction(s)". Nothing names the agent, nothing names the residue on
  disk, and nothing turns the count into a removable item.
- **Why not a task on its own.** I could not drive a real transaction into `degraded`: reaching a
  `CustodyError` needs a concurrent writer inside the profile home between two phases of the same
  transaction, and I did not find a writer that races that window. `retireEvolution`
  (`agentProfileForget.ts:351-361`) was the strongest candidate and it is clean —
  `EvolutionStore.retireAgent` (`EvolutionStore.ts:600-629`) retires only the host authority head and
  touches no file under the profile home, so the `profileManifest` captured at `intent` still matches
  when `quarantineHome` compares it. Undecided, per the contract's rule against hypothetical tasks.

### O7 — the rename window. **UNDECIDED.**

- **Gesture.** Rename a Saved Agent (`commitAgentProfileRename`).
- **Interruption point.** Between `moveProfileDirectory` (`agentProfileRename.ts:529`) and
  `writeTargetLocator` (`:391`) both directions exist simultaneously. A separate hole:
  roll-forward at `:401-405` throws *"profile rename source home retained unexpected data"* when
  `oldRoot` is non-empty; that is a plain `Error`, so the commit-path catch takes the
  `authorityState === "target"` branch and writes **no** `degraded` phase — the journal stays at
  `authority-moved` and reconcile retries it on every workspace open.
- **Journal / reconcile.** Covered at next workspace open (`Workspace.ts:3179`), and the decision is
  made from `authorityState`, not from the filesystem, which is the right anchor. `compensateProfile`
  (`:421-441`) refuses rather than guesses when it cannot restore.
- **Detectable today?** The retry loop is silent; a `degraded` rename shows only as a count (O6).
- **Why undecided.** `rename/` has never been created on this machine, so there is no field evidence,
  and I did not reproduce a crash mid-rename. The code reads correct at every branch I followed. I am
  recording the window, not claiming a defect.

### O8 — the forget window. **PROVED SAFE for crash; the degraded exit is O6.**

- **Gesture.** Agent Studio → Forget; Bridge `propose_saved_agent_removal` after approval.
- **Interruption point.** `rollForward` (`agentProfileForget.ts:380-413`) removes the locator at
  `:396` and quarantines the home at `:400`. A crash in between leaves a directory with no row.
- **Journal / reconcile.** Covered, and it reconciles at the **next workspace open**, not only on a
  retry in the same process: `reconcileAgentProfileForgets` at `Workspace.ts:3198` rolls the journal
  forward from whatever phase it stopped at, and every step is idempotent —
  `quarantineHome` returns early when the source is gone and the destination already matches the
  manifest (`:366`). Field evidence agrees: 23 journals on this machine, all `committed`.
- **Detectable today?** Not needed for the crash case; it self-heals. The `degraded` exit does not,
  and that is O6.

### O9 — a human editing `tachyon.yml` by hand. **PROVED SAFE (detected and named), both directions.**

- **Gesture.** The owner opens `tachyon.yml` and adds or deletes an `agents:` entry.
- **Interruption point.** No transaction to interrupt.
- **Journal / reconcile.** None, by design; the config watcher at `Workspace.ts:3265-3272` reloads.
- **Detectable today?** Yes, in both directions, and this is the part of the picture that works:
  a row with no `agent.yml` derives to `orphan-locator` and carries a door
  (`savedAgentState.ts:75`, `:94-103`); an `agent.yml` with no row derives to `unlisted-profile`
  with an explicit "kept on purpose" reason and a hand-deletion instruction
  (`:73`, `:104-111`). The control block of `orphan-repro.ts` shows the second case:

  ```
  --- CONTROL: profile present, roster row absent ---
    presence facts   : {"rosterRow":false,"profileOnDisk":true,"authorityRecord":true,"projection":false}
    deriveSavedAgentState -> unlisted-profile
    reason : … the profile directory is kept on purpose because it may hold work a human wants …
  ```

### O10 — the removal proposal expiring or being cancelled. **PROVED SAFE.**

- **Gesture.** Bridge `propose_saved_agent_removal`, then TTL expiry
  (`savedAgentRemovalProposal.ts:17`, 24 h) or `cancel_saved_agent_removal_proposal`.
- **Why it cannot leave residue.** `src/agents/savedAgentRemovalProposal.ts` is inert data: it
  imports only `node:crypto`, the profile *type*, and one predicate (`:1-3`). It has **no `node:fs`
  import at all**, and `admitSavedAgentRemovalProposal` (`:109-208`) is a pure function returning an
  admission. A proposal that expires or is cancelled has never touched profile, authority, roster or
  worktree — the module's own header says so (`:12-13`) and the imports prove it. The mutation
  happens only when a human approves and the host runs `forgetAgentProfileAgentCascade`, i.e. O8.

### O11 — plugin materialization. **PROVED SAFE.**

`src/plugins/engine.ts` never joins `.tachyon/agents`. Its payload root explicitly excludes
`.tachyon/…` (`:115`), and its per-agent writes go to `.tachyon/harness/` and `.tachyon/bridge-mcp/`
(`:306`, `:528`, `:914`). Searched: every `readdirSync`, every `mkdir`, and every `"agents"` literal
in the file.

---

## 6. Where I looked and found nothing

Stated explicitly, because "I did not find it" and "it does not exist" are different claims.

- Every `path.join(…, ".tachyon", "agents", …)` in `src/` — 15 hits, all read. Yields C1-C4 and
  R1-R4, plus read-only sites (`agentProfileReader.ts`, `Workspace.ts:4145`/`:4172`,
  `agentProfileRename.ts:182`, `agentProfileForget.ts:188`, `soul.ts:294`/`:768`).
- Every `` `.tachyon/agents/…` `` template literal — 18 hits, all read; all are diagnostics, pointer
  strings, or the `initLogic.ts:119` gitignore entry.
- Every `readdirSync` in `src/` — 84 hits. **Exactly one** reads `.tachyon/agents/`:
  `Workspace.ts:4172`.
- The promise-API `readdir` too, because a sync-only search would have missed it: there is one more
  reader, `soul.ts:766-791` `findFoldedProfileCollision`, which lists `.tachyon/agents/` to reject two
  homes whose owners fold to the same ASCII case. It skips any entry whose Soul manifest is missing
  (`:781-783`), so an empty orphan directory is invisible to it as well — but that is CORRECT for its
  purpose (it hunts colliding Soul profiles, not residue) and is not counted as a defect here.
  So there is exactly one sweep that reports profile-home state to a human, and §7 is about it.
- `src/continuity/orphanGc.ts` in full: it scans `.tachyon/continuity/` for `<name>.md` and
  `<name>.state.json` (`:29-47`) and deletes continuity plus activity for unknown names. It **never
  reads `.tachyon/agents/`** and cannot see a profile-home orphan. That is a coverage gap, not the
  format blindness the brief warned about — but it means the module named "orphan GC" is not a
  detector for this class at all.
- The config file watcher at `Workspace.ts:3265-3272` watches `.tachyon/agents/*/agent.yml` — the
  FILE glob. Creating or deleting an empty directory under `.tachyon/agents/` fires nothing. (The
  broader `.tachyon/*` watch at `:3277` is one level deep and refreshes pins/schedules only.)
- `reconcile_worktree_hygiene`, `worktree_hygiene` and `worktree_process_hygiene`: none of them joins
  `.tachyon/agents`.

---

## 7. The detector, and the exact shape of its blindness

There is one sweep that enumerates `.tachyon/agents/`: `Workspace.savedAgentSubjects`
(`Workspace.ts:4162-4179`), feeding `reconcileSavedAgentRoster` (`:4188-4213`), which the Bridge
exposes as `reconcile_roster`. It is well built for the question it was designed for (SDD 494), and
it does the right thing at `:4172-4174` — it reads the DIRECTORY:

```ts
for (const entry of fs.readdirSync(path.join(this.workspaceRoot, ".tachyon", "agents"), { withFileTypes: true })) {
  if (entry.isDirectory()) names.add(entry.name);
}
```

But the fact it then measures for that name is a FILE (`Workspace.ts:4145`):

```ts
profileOnDisk: fs.existsSync(path.join(this.workspaceRoot, ".tachyon", "agents", name, "agent.yml")),
```

So for a directory-only residue all four facts are false, and `deriveSavedAgentState`
(`savedAgentState.ts:68-78`) takes its first arm:

```ts
if (!rosterRow && !profileOnDisk && !authorityRecord) return "absent";
```

and `savedAgentRemovalDoor` answers (`:119-120`):

> `{ door: null, reason: "no roster row, no profile and no authority; there is nothing to remove" }`

**The sweep enumerated the directory, then reported that nothing is there.** That is worse than not
looking: it is a false negative delivered as a proof. And the control in `orphan-repro.ts` shows the
blindness is precisely the format and nothing else — with `agent.yml` present the same function
correctly names `unlisted-profile` and explains what to do.

This is the class of blindness the brief named. The runtime-home sweeps were blind to directories
because `grok`/`hermes` materialize `bridge-mcp/<name>.<runtime>/` as a directory while
`claude`/`opencode` write a file; 35 dead homes reached 2.2 GB unseen. Here the two formats are
"directory containing `agent.yml`" and "directory containing nothing, or containing only Soul or
Evolution bytes". The sweep checks one and enumerates the other.

Note also that `absent` is not a wrong *design* — `deriveSavedAgentState` is a pure function over
four booleans and, given all-false, `absent` is the only honest answer. The defect is upstream: the
fact vocabulary has no fact for "the home exists", so a directory that exists cannot be reported.

---

## 8. Verdict

### Proved safe

| origin | proof |
| --- | --- |
| **O8** forget's locator-before-home window, crash case | idempotent roll-forward (`agentProfileForget.ts:366`, `:380-413`) driven at every workspace open (`Workspace.ts:3198`), plus 23/23 `committed` journals in the field |
| **O9** human hand-edits of `tachyon.yml`, both directions | `orphan-locator` and `unlisted-profile` are named and carry an explicit door or an explicit "kept on purpose" (`savedAgentState.ts:73`, `:75`, `:92-111`) |
| **O10** removal proposal expiry / cancellation | the module has no `node:fs` import and no mutation (`savedAgentRemovalProposal.ts:1-3`, `:109-208`) |
| **O11** plugin per-agent materialization | `.tachyon/…` is excluded from the payload root (`plugins/engine.ts:115`); no `.tachyon/agents` join anywhere in the file |
| **R1** forget's quarantine | `fs.renameSync` of the whole tree, with a converge check (`agentProfileForget.ts:372-377`) |
| **R3** rename's `rmdir` | guarded to refuse a non-empty source (`agentProfileRename.ts:402`) |

### Proved defective

| origin | one-line defect | task |
| --- | --- | --- |
| **O1 + O2** | `removeAgentProfileIfExact` unlinks `agent.yml` and never `rmdir`s the home, so every rolled-back or crash-recovered canonical create leaves an empty `.tachyon/agents/<name>/` permanently, and reports a clean rollback | `t-4a1f85` |
| **O3** | `forgetAgent.ts:57` removes `agents/<name>/evolution` and never the parent, with no journal and no reconcile | `t-4a1f85` (same removal-completeness defect, same fix surface) |
| **§7** | the only sweep that reads `.tachyon/agents/` measures `agent.yml` and therefore reports a directory-only residue as `absent` / "there is nothing to remove" | `t-8b58b3` |
| **O4** | `sectionOf` accepts `terminals:`, so the Soul gate passes for a terminal and `publishCanonicalSoulFiles` publishes `.tachyon/agents/<terminal>/{SOUL.md,profile.json}` with no `agents:` row — on the success path | `t-359469` |
| **O5** | the declared-terminal delete door removes the roster row and never touches the profile home, with no journal, so no workspace open ever reconciles it | `t-af4a5f` |

### Not decided

This list is mandatory and it is not empty.

1. **O6 — whether a `degraded` transaction is reachable in practice.** The consequence is proved by
   inspection (roster row already removed at `locator-removed`, home still present, reconcile skips
   `degraded` forever at `agentProfileForget.ts:539` / `agentProfileLifecycle.ts:803` /
   `agentProfileRename.ts:573`). What I could not show is a real writer that races the window and
   produces the `CustodyError`. `retireEvolution` was checked and is clean. **No task opened**, per
   the contract's rule.
2. **O7 — the rename windows.** Both directions of orphan exist mid-transaction and the recovery
   reads correct at every branch, but `rename/` has never run on this machine and I did not
   reproduce a crash. Includes the "source home retained unexpected data" path
   (`agentProfileRename.ts:402`), which retries silently on every workspace open rather than
   degrading — plausibly fine, unmeasured.
3. **C3 — whether `EvolutionStore.atomicWrite`'s `mkdir -p` is reachable for a name outside
   `agents:`.** The ungoverned `mkdir -p` of the profile home is real (`EvolutionStore.ts:2014`);
   both callers I traced are gated behind a canonical profile. If a third caller exists or arrives,
   C3 becomes a journal-free producer of orphan homes. Worth re-asking when slice C lands.
4. **O4's UI reachability.** The engine accepts a `terminals:` name for every Soul mutation; whether
   the Agent Studio webview ever sends one was not measured. `t-359469` is opened on the engine-level
   gate, which is defective regardless of who calls it.
5. **What slice C intends for `terminals:` names.** If the directory-derived roster is meant to
   include or exclude them, that decision changes whether O4's residue is a ghost agent or a naming
   collision. Not mine to decide here.
6. **Whether an empty `.tachyon/agents/<name>/` is safe to delete automatically.** `savedAgentState.ts:104-111`
   already argues that a profile directory is kept on purpose because it may hold a human's work. An
   empty directory holds nothing, and a directory holding only `SOUL.md` holds a great deal. The
   removal policy is a decision for the fix tasks, not a measurement.

---

## 9. One line for the switch

The switch (`t-ae221c`) is not blocked by a missing detector; it is blocked by a detector that
answers "nothing is there" about a directory it just enumerated, and by two removal helpers that
leave that directory behind. Fix `t-4a1f85` and `t-8b58b3` and the ghost cannot be created or, if it
already exists, cannot hide.

---

## 10. What changed after this measurement

Added 2026-08-07, after `t-4a1f85` and `t-8b58b3` landed. **Every transcript above is left exactly as
measured** — it records the state of the code on the day of the hunt, and rewriting it would destroy
the record. What follows is what re-running the same scripts prints now.

- **R2 and R4 no longer abandon the home.** Both call `removeEmptyAgentProfileHome`
  (`src/config/agentProfileHome.ts`), whose mechanism is `rmdir` and whose refusal on a non-empty
  directory is the guard — so an emptied home goes, and one still holding `agent.yml`, `SOUL.md` or
  Evolution bytes stays and is reported. The refusal is never escalated to an error: for the
  lifecycle compensation, throwing there would land on `phase: "degraded"`, which every reconcile
  skips forever (§O6).
- **`orphan-repro.ts` now prints the opposite of §5.** ORIGIN A and ORIGIN B both report
  `.tachyon/agents/<name>/ exists : false` — the residue is gone at the source, through the same
  production helpers. The CONTROL blocks are unchanged.
- **The detector has a fifth fact.** `profileHomeOnDisk` joined `SavedAgentPresenceFacts`, and a
  home with no definition in it derives to the new state `orphan-home` with a reason that names the
  directory and the `rmdir` that separates residue from a human's work — instead of `absent` /
  "there is nothing to remove". `spec.md`'s ownership table, resolution table and open questions were
  updated with it.
- **`orphan-terminal-soul-repro.ts` now prints `orphan-home` where §O4 shows `absent`.** The
  mechanism it reproduces is untouched — a `terminals:` name must not get a profile home published
  for it at all, and that is `t-359469` — but the residue it leaves is no longer invisible.
- **Untouched, and still open:** O4 (`t-359469`) and O5 (`t-af4a5f`), both `terminals:`-shaped, and
  every entry of the "not decided" list except #6, which the two tasks above resolved.
