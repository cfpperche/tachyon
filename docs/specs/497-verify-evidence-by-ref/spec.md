# 497 — verify-evidence-by-ref

_Created 2026-08-08._

**Status:** draft

<!-- Drafted from the maintainer's decisions on 2026-08-09, in his words where possible.
     Intent is his; this file is a transcription awaiting ratification. -->

## Intent

Tachyon has one door that asks "was this content proved green?" — the land suggestion — and the only
answer it accepts is a JSON file that **this repository's own script** writes into
`.git/tachyon-verify/<tree>.json`. Nothing in `src/` writes that file. So for every other project the
`verified-tree` precondition is red forever, the all-or-nothing rule withholds the command, and the
whole surface is dead code with a message telling the project to adopt our gate.

At the same time the proof already exists and is thrown away. `.github/workflows/ci.yml` runs
`npm run verify:full` on push and pull_request — the same command, writing the same record — inside a
runner that is destroyed seconds later.

The maintainer's decision, stated on 2026-08-09:

> "a verdade é uma só, isso é coisa de CI e não de agente lembrar rodar"
>
> "tem que funcionar com qualquer CI, então vamos remover o verify da worktree também e a tool também
> — nunca usamos nem nunca vamos usar isso"

So the product stops **executing** checks. Running a command is the agent's job or the CI's job; both
already have a shell. The product owns only **the evidence**: what was proved, about which content,
and by whom. Evidence arrives as a **git ref keyed by tree**, publishable by any CI with nothing but
`git`.

Two properties make this fit rather than merely work:

- **Keyed by tree, so the proof describes content.** A message amend or a rebase that changes no
  content keeps the same tree, and the green stands. A rebase that absorbs new content produces a
  different tree, and the green correctly disappears.
- **`--ff-only` closes the circle.** The tree that lands is byte-identical to the tree CI verified, so
  "CI passed on the branch" and "this trunk state is verified" become the same sentence. Under a
  merge commit they would not be — the combined tree is new and nobody verified it, which is what
  `verify-record.mjs audit` already reports on every push.

Done looks like: a project whose CI publishes one ref gets a working land door, with no Tachyon
script, no forge API, no token, and no artifact download. A project that publishes nothing gets no
land command — "não declarou, não tem verify".

## Acceptance criteria

- [ ] **Scenario: CI publishes, the product reads**
  - **Given** a project whose CI runs its own gate and, on success, publishes a verification record
    for the tree it ran on
  - **When** the human opens the delivery/land surface for a worktree at that content
  - **Then** the `verified-tree` precondition is green, and its detail names the tree and when it was
    proved — with no Tachyon-authored script anywhere in that project

- [ ] **Scenario: content moved, proof does not follow**
  - **Given** a published record for tree A
  - **When** the worktree's HEAD content changes so its tree is B
  - **Then** `verified-tree` is red, and the fix text says what is missing rather than telling the
    project to run our gate

- [ ] **Scenario: amend that changes no content**
  - **Given** a published record for the tree at HEAD
  - **When** the commit message is amended, producing a new commit sha with the same tree
  - **Then** the precondition stays green and the suggested command names the NEW sha

- [ ] **Scenario: nothing published**
  - **Given** a project that publishes no verification evidence at all
  - **When** the human opens the land surface
  - **Then** the precondition is red with a reason naming the absent evidence, and no command is
    offered — the product neither runs a check nor invents one

- [ ] **Scenario: evidence exists but was never fetched**
  - **Given** a record published to the remote, with no local ref because nothing fetches
    `refs/tachyon/*`
  - **When** the human opens the land surface
  - **Then** the precondition reads "published, not fetched" — distinct from both green and from "no
    evidence" — and offers a one-click fix that writes the fetch refspec into this repository's git
    config

- [ ] **Scenario: the product proposes, the human writes**
  - **Given** the fetch refspec is absent
  - **When** the product detects the situation
  - **Then** it does not write git config on its own; the config changes only after the human accepts

- [ ] **Scenario: a local run and a CI run are indistinguishable to the reader**
  - **Given** the same tree proved once by a developer's local gate and once by CI
  - **When** the product reads the evidence
  - **Then** both are the same object in the same place, read by the same code path, differing only
    in the provenance they carry

- [ ] The product contains no code path that executes a project's verification command.
- [ ] `verify_agent`, `settings.worktree.verify`, per-agent `verify:`, the verify badge and the
      recorded `VerifyState` no longer exist.
- [ ] Publishing requires only `git`. No forge API, no token, no CI-vendor-specific step.
- [ ] The record's format and ref layout are documented well enough that a project can publish from a
      shell script without reading Tachyon's source.

## Non-goals

- **Running anything.** The product does not execute, schedule, retry or queue a check. This spec
  removes that capability rather than relocating it.
- **Judging the check.** Whether a project's gate is any good, what it covers, and how long its proof
  should stay valid are the project's business.
- **Forge integration.** No reading GitHub check runs, no API, no token. That path binds to one
  vendor and was rejected explicitly.
- **Authenticating the publisher.** Anyone who can push a ref can publish a record. That is stated as
  a boundary, not closed — the maintainer's standing instruction is not to invent security rules he
  did not ask for.
- **Migrating other people's data.** One user; if a state does not exist in this workspace it does
  not exist anywhere.

## Decisions

Ratified by the maintainer on 2026-08-09 ("concordo com tudo"). Each records what was rejected,
because the rejected option is the part that gets re-proposed later.

1. **The local file goes; one writer, one shape.** `verify:full` publishes to the ref instead of
   writing `.git/tachyon-verify/<tree>.json`. A local run and a CI run become the same object in the
   same place, read by one code path — which is the entire point of the change. _Rejected:_ keeping
   the file as a second source, which would leave two proofs that can disagree, exactly the state
   t-40e655 was cleaning up. _Carried cost:_ the file had a 50-record prune; refs do not prune
   themselves, so a retention policy has to be part of publishing rather than an afterthought.

2. **The ref points at a blob.** `git update-ref refs/tachyon/verify/<tree> <blob>`, read with
   `git cat-file blob`. It is the smallest object that works — no commit, tree or tag. _Rejected:_ an
   empty commit carrying the record in its message, on the grounds of being conventional. If a
   concrete tool turns out to assume refs point at commits, that is a measurement that flips this
   decision; it is not a reason to pay for the heavier object up front.

3. **Three answers, not two, and a network call only on demand.** Without the fetch refspec the
   product cannot tell "nobody published" from "published and I did not fetch" — two opposite
   situations wearing the same red. One targeted `git ls-remote refs/tachyon/verify/<tree>`
   separates them:
   - local ref present → **verified**
   - local absent, remote present → **published, not fetched** + a one-click fix
   - neither → **no evidence**, no command

   The call happens when the human opens the surface, never on the 3s tick. _Rejected:_ writing the
   refspec into the repository's git config at init — the product mutating a project's setup
   unasked and silently. Also _rejected:_ documenting it only, which is the "works if someone tells
   you" failure this spec exists to remove. **The product proposes; the human's click writes.**

4. **The fingerprint stays, is displayed, and is never compared.** With CI as the producer the
   environment always differs from the reader's, so equality would refuse everything. Provenance is
   still worth showing. This extends t-40e655's finding: equality belongs only to a writer deciding
   whether it may skip work.

5. **The seven-day window stays, with no knob.** Its reason survives CI: age bounds the blast radius
   of what the tree and the fingerprint cannot see — an upgraded system library, a rotated
   credential. It becomes configurable when a project asks, not before; a knob nobody requested is
   the ceremony this whole line of work is removing.

## Open questions

1. **Retention.** Refs accumulate. Does publishing prune older records (and by what rule — count,
   age, reachability), or does a separate step? Falls out of Decision 1 and needs an answer before
   the first publish ships.

2. **Multi-remote.** `ls-remote` against which remote when a checkout has several? _Leaning:_ the
   one the branch tracks, and say which one was asked when the answer is "no evidence".
