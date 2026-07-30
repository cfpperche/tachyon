> **Status: RATIFIED AND EXECUTED.** `t-a95ae8` landed this document on `main`, where it had been
> missing: five tasks and four agents executed the cut against a plan the trunk did not hold, which is
> why it is here now rather than only on the branch that authored it.
>
> The plan is preserved AS WRITTEN — it is the record of what was decided, not a status page. Two
> things it predicted differently are worth knowing before you read it:
>
> - §1A calls the wire renames one cut with a protocol bump. That happened for the `task.board` input
>   (`liveAdhocAgents` → `liveTemporaryAgents`, `ENGINE_SHELL_PROTOCOL` 5 → 6 in `t-4cc561`), but the
>   `mode: "adhoc"` handoff discriminant and the sidebar row's `adhoc` flag were deliberately KEPT.
>   They remain a closed, documented boundary — see `test/unit/agentSpeciesNomenclature.test.ts`.
> - §1D calls the residue "cosmetic, zero risk". It was not: the sweep produced broken articles in
>   Bridge tool descriptions that agents read as instructions, and a `.toLowerCase()` needle with
>   capitals that silently killed two guards. Mechanical is not the same as riskless.

# Removing the canonical / ad-hoc / declared species — the cut

**Task:** `t-7e5843` · **Status:** architecture + cut plan, NO implementation · **Author:** claude-reviewer, 2026-07-29

> **Revision note.** The first version of this document proposed an additive compatibility window,
> dual-write and a ledger migration. That was written against the task body before the human decision
> of 2026-07-29 landed, and it is now wrong on exactly the point that matters: **nothing is migrated
> and nothing is preserved.** The plan below is the cut. Keeping the migration version around "in
> case" would be the eternal-legacy reflex this task exists to remove, so it is replaced, not
> appended.

---

## 0. The one thing the adversarial pass must protect

The instruction is to use adversarial review *only* to avoid deleting a Saved/Temporary distinction
that is semantically necessary. There is exactly one, and it survives:

**Lifetime is a declared property of the instance.** "Will this definition still be here tomorrow?"
is a real promise a human relies on. It stays, as authored data.

What goes is **inferring** that promise from which store the definition sits in. Today one storage
fact — "is it in `tachyon.yml`?" — answers five unrelated questions: resume policy, admission,
lifecycle, roster shape, and lineage durability. That is `declared` doing five jobs, and it is the
whole defect.

So: **`lifetime: "saved" | "temporary"` is declared; storage is never a branch.** No species, no
second machine, no derived behaviour.

Probe stays separate and out of scope.

---

## 1. Inventory, classified by what the cut has to do with it

Counts are files containing the term on `185593ba` — blast radius, not work. Most are prose.

| Term | `src/` | `test/` | `docs/` |
|---|---|---|---|
| `canonical` | 149 | 133 | 323 |
| `declared` | 151 | 158 | 304 |
| `adhoc` | 34 | 28 | 49 |
| `ad-hoc` | 34 | 30 | 163 |

### 1A. Wire — renamed in one cut, protocol bumped in the same commit

- `src/runtime-api/activityProjection.ts:13, :81` — `declared: z.boolean()`, shipped in rows.
- `src/runtime-api/handoffProjection.ts:25, :195` — `declared: boolean`.
- `src/runtime-api/workspaceProjection.ts:31` — `declared: boolean`.
- `src/runtime-api/handoffCommands.ts:13, :17, :44` — `"adhoc"` as a **discriminant literal**.
- `src/config/agentProfileStudio.ts` — `kind: z.literal("canonical")` in a `.strict()` schema.

These are `.strict()`, so an older peer **refuses** rather than ignores. Under the cut that is a
feature, not a hazard: refusal is the intended behaviour (§3).

### 1B. Persisted state — deleted, not read

- `src/resume/SessionLedger.ts:181` — `declared: boolean`, persisted on every installed machine.

Nothing reads it after the cut. No derivation, no back-fill. See §4.

### 1C. Duplicated implementation — the actual work, and it is small

- `src/agents/AgentManager.ts:895` — `private adhoc = new Map<string, AgentDef>()`.
- `:976` — `getConfig()?.agents[name] ?? this.adhoc.get(name)`, the union that makes two stores look
  like one and is where "which species" is really answered.
- `:1256-1257`, `:1409` — membership and roster union across both stores.
- `src/agents/adhocAdmission.ts` — `SUPPORTED_ADHOC_AGENT_RUNTIMES`, a second admission path.
- `SessionLedger.stripDeclaredParent` — strips lineage **only when `rec.declared`**. Deleted outright;
  with no species there is nothing to strip, and the inversion it caused (Saved agents losing their
  parent while Temporary agents kept theirs) disappears with it rather than being fixed.

### 1D. Cosmetic — mechanical rename, zero risk

The residue of the 149/151 once 1A–1C are gone: local identifiers, comments, log strings.

### 1E. Tests / fixtures

`writeCanonicalAgent`, `canonicalAgentsYaml`, `canonicalAgentSecrets` and ~160 test files. They follow
their subject.

### 1F. Historical docs — marked, never rewritten

`docs/specs/423`, `352`, `478`, `482`, parity changelog rows. They record decisions made when those
words were true. A header marks them historical; the prose stays.

---

## 2. The contract

```
AgentInstance {
  name
  runtime                            // adapter + executable + selectors
  lifetime: "saved" | "temporary"    // DECLARED, never derived
  identity                           // agentId; for saved, the profile + authority behind it
  lineage?                           // who spawned this instance — durable for both lifetimes
}
```

Two ports, differing only in what they promise about the definition:

- **Saved** — creates/edits a durable definition through the canonical transaction that SDD 482 phase
  4 already built (profile + authority + roster, one txid, compensation).
- **Temporary** — creates an instance whose definition lives as long as the session, and says so.

Resume policy reads `lifetime`. One instance store. One admission path, keyed on runtime.

---

## 3. Cross-version: refuse and replace, do not interpret

**Bump `ENGINE_SHELL_PROTOCOL` 4 → 5, in the same commit as the first payload change.** Never a
payload change on an unchanged protocol — that is 0.56.110 D1 verbatim.

Under the cut the bump does one job: **make an incompatible pairing impossible and say so
actionably.** Negotiation is already exact (`min === max`), so a mismatch already refuses; what must
be added is that the refusal *names the recovery* instead of surfacing as a decode error.

- **Upgrade**: installing the new extension **replaces** the persistent engine. It does not pair with
  an old one and does not read old state.
- **Downgrade**: same rule in reverse — restage the engine rather than leave a newer one paired with
  an older client. This is the D2 lesson, and it is the half that bit hardest last time.
- **Release gate** exercises current client ↔ previous engine **and** the reverse. A bump tested only
  forward is half-tested.

No dual-read, no dual-write, no translation shim, no alias. An incompatible peer is refused, not
accommodated.

---

## 4. Reset, and the recreate procedure

Ratified ceremony: **the human stops and removes every agent before installing the release.**

Therefore the release **requires empty legacy state and refuses activation** if it finds old agents,
with an instruction naming what to do. That refusal is cheaper and safer than any migrator, and it is
the only "compatibility" logic in the whole plan.

**What the gate inspects (ratified 2026-07-29):**

| Checked | Not checked |
|---|---|
| Legacy ledger rows | Explicit product **terminals** — they are not agents |
| Legacy roster / `agents:` entries | **External tmux sessions** Tachyon does not own |
| **Live tmux sessions of Tachyon-owned AGENTS** | |

The live-session check is the half that matters: a human can empty the config and still have a pane
running, and pairing silently with a live legacy pane is exactly what this gate exists to prevent.

**The refusal lists what it found and never acts on it.** It names each agent session and the governed
action to stop it. It does **not** auto-kill — killing someone's live agent to make an install proceed
would be the install deciding something only the human should.

- **Deleted, not migrated:** ledger rows, roster entries, ad-hoc definitions, runtime state, sessions,
  lineage, worktree records, assignments, continuity.
- **Preserved:** the project handoff, and human-authored configuration explicitly chosen to carry
  over. Nothing else.
- **`codex-canonico`** is recreated by hand in the new format as part of the install, so the
  coordinator exists before anything else needs it.
- **The squad** is then recreated through the governed Saved-Agent door.

**What this costs, stated honestly:** every running agent's session, lineage and worktree is gone. The
human ratified that. It is the reason this plan is short.

---

## 5. Steps

Each lands green on its own tree. There is no reversible/irreversible split here — the cut *is* the
plan, so ordering is about keeping each step reviewable, not about retreat.

1. **Refusal gate + protocol 5.** The release refuses activation on non-empty legacy state with an
   actionable message that lists what it found; bump ships in the same commit. Proof: fail-before on
   three separate seeds — a legacy ledger row, a legacy roster entry, and a live Tachyon agent
   session — plus two negative controls proving a product terminal and an external tmux session do
   NOT block.
2. **Introduce `lifetime` and delete `declared`** across ledger, the four projections and the Studio
   literal — one cut, no coexistence.
3. **Collapse `AgentManager.adhoc` into one instance store.** Largest step; its own review.
4. **Collapse `adhocAdmission` into one admission path** keyed on runtime.
5. **Delete `stripDeclaredParent`.** Lineage durable for both lifetimes.
6. **Cosmetic renames, tests, fixtures.**
7. **Docs: mark historical, update the parity/architecture matrix.**

Fail-before/pass-after applies to steps 1, 2, 3, 4 and 5. Steps 6–7 are mechanical.

---

## 6. What will NOT happen

- No migrator, no grandfathering, no dual-read/dual-write, no permanent alias.
- No rewriting of historical specs — marked, not edited.
- Probe is not unified into Agent Instance.
- No attempt to interpret old ledger/roster/runtime state. It is deleted.

---

## 7. Open for the human

**Nothing.** Every decision this plan needed is ratified:

- no migration, no preservation (2026-07-29);
- the cutover ceremony — human empties the Fleet, `codex-canonico` recreated by hand, squad through
  the governed door (2026-07-29);
- the gate's scope, including live Tachyon agent sessions, the two exclusions, and list-don't-kill
  (2026-07-29).

Step 1 is ready to implement on the go-ahead.
