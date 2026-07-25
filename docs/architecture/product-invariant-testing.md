# Product Invariant Testing Standard

This is a Tachyon-repository standard, not a Tachyon product default. It is delivered to agents only
because this repository explicitly lists it under `settings.projectGuidance.files`. Projects using
Tachyon own their test vocabulary, tools, paths and verification commands.

Tachyon does provide a generic enforcement substrate for project-declared gates: it freezes the approved
delegation authority, authenticates durable authority records with a host-custodied HMAC key, and checks a
host-custodied freshness head before trusting them. That product hardening protects any project that uses
the applicable Tachyon delegation/verification flow; it does not write Product Invariants, choose a test
framework or command, or impose this repository's approval policy on consumers.

## What a Product Invariant is

A **Product Invariant** is a stable, externally observable product promise with a fixed oracle. A
**Product Invariant Test** is executable evidence that the promise still holds. It is a semantic
classification: it says **what must remain true**, not how many processes, adapters or UI layers the
test crosses.

`unit`, `integration`, `browser`, `full-stack`, `e2e` and `installed-system` describe execution scope or
topology. A Product Invariant may use any of those topologies and may move between them without changing
its identity, provided its promise and oracle do not change. Do not name this category `e2e`; that would
confuse a current execution mechanism with the durable product contract.

A test qualifies only when all of these are true:

1. The promise is observable at a product boundary and matters independently of the current implementation.
2. A regression would violate that promise, not merely an internal arrangement or preferred code shape.
3. The expected result can be written as a fixed oracle that is not derived from the code under test.
4. The promise has a durable source: a ratified product decision, architecture record or shipped SDD spec.
5. Maintainers intend changes to the promise to require an explicit product decision.

Ordinary regression coverage remains valuable and does not need promotion. A test that follows a mutable
implementation detail, guards a one-off bug, or is rewritten freely with an internal refactor stays in the
unit/integration suite.

## Responsibilities by verification layer

| Layer | Primary responsibility | What it does not prove |
|---|---|---|
| Unit test | Local logic, branches and failure modes with narrow dependencies | That an external product promise survives real composition |
| Integration test | Contracts between concrete components or adapters | That the asserted contract is a durable product promise |
| Product Invariant Test | A registered `PI-*` promise against its fixed oracle | Every implementation detail or every installed environment |
| Dogfood | Representative use of a built or installed system, including qualities difficult to automate | A repeatable merge gate unless the route and oracle are declared as an invariant |

The layers complement one another. Product Invariant coverage does not replace focused regression tests,
and headless execution does not replace installed dogfood when the registered promise depends on a real
VS Code host, tmux, Chrome or another system driver.

## Identity, registry and required metadata

IDs use `PI-` followed by three decimal digits (`PI-001`, `PI-002`, ...). Allocate monotonically, never
renumber an existing invariant and never reuse a retired ID. Retirement leaves a registry entry with its
status and superseding decision so historical Tasks and specs keep meaning.

This document is the governance registry and source of the full contract metadata. The machine-readable
active manifest at `test/product-invariants/registry.json` is the execution source of truth for which IDs
must run. Every active entry must exist in both places with the same ID, evidence file and durable source;
the Product Invariant runner fails closed when a registered active file or assertion is absent, and also
when a `PI-NNN-*.test.ts` file is not registered. Retired and superseded history remains in this document
but is removed from the manifest's `active` list only through the governance workflow below.

Every registry entry records:

- **Promise** — the externally observable statement that must remain true.
- **Source** — the ratified decision/spec that owns the promise.
- **Executable evidence** — the file under `test/product-invariants/**` and its focused command.
- **Topology** — component, integration, browser/full-stack or installed-system; topology is metadata only.
- **Environment and allowed variance** — supported drivers plus exactly what mechanics may vary.
- **Fixed oracle** — the expected outcomes that adaptation must not infer or rewrite.
- **Gates** — PR/merge, CI, release and any installed-dogfood evidence requirement.
- **Status and owner** — active, quarantined, retired or superseded, with an accountable maintainer.

The executable filename and top-level test title include the ID. The machine manifest names the durable source,
and this governance entry names topology and the full contract; the test does not duplicate either as a third,
drift-prone metadata object. Assertions are the executable form of the registry oracle; comments or metadata
cannot silently describe a stronger promise than the assertions prove.

## Location and commands

Executable invariant files live only under:

```text
test/product-invariants/PI-NNN-short-promise.test.ts
```

Active IDs and their exact evidence files are declared in:

```text
test/product-invariants/registry.json
```

The manifest uses schema version 1 and records `id`, `file` and the workspace-relative durable `source` for
each active entry. It is deliberately separate from Vitest discovery: adding another PI file cannot make a
missing registered promise disappear, and leaving an active entry without its file cannot produce a green gate.
The runner also cross-checks those three fields against each active entry in this governance registry. The
focused gate owns a dedicated Vitest setup with an unconditional `beforeEach(() => expect.hasAssertions())`
hook, and validates that setup/config before execution, so a conditional early return or an assertion-free test
is a failure rather than machine-readable evidence. An invariant file may repeat the guard so the aggregate full
suite has the same safety property, but that repetition is executable protection rather than contract metadata.

The focused repository gate is:

```bash
npm run test:invariants
```

The normal full verification includes the same files. The focused command is a visible product-contract gate,
not a second suite with a different source of truth. Moving an existing test into this directory is a product
classification decision; do not mass-relabel existing regression tests.

## Environmental adaptation and the fixed oracle

A runner may adapt **mechanics** that are explicitly allowed in the registry, for example locating a supported
binary, allocating an ephemeral port or directory, normalizing platform path separators, or selecting a
declared driver implementation. Adaptation must not choose the expected behavior.

In particular, a Product Invariant Test must not:

- derive expected values from the implementation, its current output, a generated snapshot or the same
  implementation-controlled transformation used to produce the actual result. A registered relational promise
  may compare output with a declared source artifact (for example, exact byte preservation), but the source,
  relationship and accepted variance must be fixed by the registry rather than discovered from the output;
- branch the expected promise by operating system, runtime or discovered capability unless that exact variance
  is registered;
- auto-update snapshots or assertions to make changed behavior green;
- weaken the oracle because a topology is expensive or a driver is unavailable.

Changing topology while preserving the promise is maintenance. Changing the promise or accepted outcomes is
product governance and follows the workflow below.

### Named delegation oracles

A task-specific named `behavior_test` is not automatically a Product Invariant, but it follows the same
fixed-oracle separation. When a project opts into Tachyon's named-test adapter, its configured `stubPath`
(the compatibility key retained by the configuration schema) must resolve to a pre-existing, tracked,
project-owned test. The delegator commits the real failing oracle before spawn; Tachyon binds its SHA-256 and
requires the same bytes at BASE and HEAD. Tachyon does not generate a placeholder from the task prose and does
not add that oracle to the implementer's `owns` scope.

The verifier contract is the project configuration snapshot captured at delegation creation, including an
explicitly absent setting. Top-level `settings.verify.prepare` is a project-owned argv command used for
both named and `cmd:` gates; a named adapter requires it plus `executorPaths`, the tracked manifest,
lockfile and runner/config inputs that define how the oracle is executed. Their committed hashes are bound
at spawn and must match BASE and HEAD.

BASE and HEAD commands run from separate tracked-only clones outside the source repository, with checkout
hooks neutralized, the source remote removed and clean-state checks. `prepare` provisions each clone's runner
environment independently. Tachyon gives each phase private temporary directories and private roots for the
common npm, Yarn, pip and uv caches, so those implicit channels, ignored ancestor dependencies, later config
changes and a source remote cannot become verification evidence. Common ambient shell/language startup variables
that directly inject code or dependency search paths are removed; a tracked project wrapper may set them
deliberately. This boundary is not a filesystem sandbox:
the inherited login home, project-selected toolchain configuration, explicit environment variables and
deliberately absolute external paths remain trusted project inputs and must not derive the expected result.
Tachyon supplies no package-manager setup default; each project declares the mechanics and all executor inputs
it relies on.

### Generic authority integrity and freshness

The approved delegation snapshot is authority, not ordinary workspace data. It includes the immutable task
contract and scope plus the exact project-selected verification settings, fixed-oracle hash and executor-input
hashes that apply to that delegation. An explicitly absent setting is part of the snapshot. Once captured, those
contract fields remain frozen for the delegation's lifetime, including fixer/reuse rounds; an implementer cannot
adopt a later root configuration, registry edit or replacement oracle. A newly approved contract requires a new
delegation rather than an in-flight rewrite of the existing snapshot. Append-only lifecycle provenance may evolve
only through host-authorized mutations that preserve the frozen contract.

Tachyon authenticates the complete durable canonical Delivery or legacy delegation authority record with
HMAC-SHA-256 under a host-custodied secret, domain-separated and bound to the canonical workspace. Integrity alone
is insufficient because an older, correctly signed record could otherwise be replayed. A host-custodied freshness
head outside the workspace therefore binds each authority identity to its current revision and MAC. Creation and
authorized mutation prepare the next head durably before committing the workspace record; reads and verification
fail closed when the key or head is unavailable, or when a record is unsigned, stale, tampered, rolled back,
misplaced or replayed from another workspace.

This seal proves that Tachyon is enforcing the authority snapshot that the project approved; it does not prove
that the promise itself is a good product decision. Projects still own their promises, oracles, frameworks,
commands and approval rules. The role model below is policy for the Tachyon repository, delivered through its
opt-in project guidance, rather than a mandatory governance workflow for consumers.

## Change governance

### Authorship, review and approval

Agents write and propose Product Invariants: they may draft the promise, fixed oracle, registry metadata and
executable evidence. Authorship is not approval. Before a new invariant becomes active, both of these independent
judgments are required:

1. An independent reviewer, distinct from the implementer, demonstrates that the proposal expresses a stable
   externally observable promise and that its executable evidence has meaningful RED/GREEN proof: it fails for
   the promised regression at the approved BASE and passes only with the intended behavior at HEAD.
2. A maintainer approves the product promise and accepted outcomes. The maintainer's approval ratifies what the
   product guarantees; RED/GREEN alone cannot do so.

The implementer may author or revise a proposal but cannot approve their own implementation, oracle equivalence or
RED/GREEN evidence. If promise, accepted outcomes, allowed variance, strength, identity and active status all remain
unchanged, a topology, runner, path or other mechanically equivalent evidence change may proceed with independent
review alone when repository policy explicitly permits it. Any uncertainty is escalated to the maintainer.

Weakening, removing or changing a promise or fixed oracle; broadening accepted outcomes or environmental variance;
quarantining, retiring or repurposing an active entry; or otherwise reducing its gates always requires explicit
maintainer approval and a ratified product decision. Neither an agent proposal nor an independent review can grant
that product authority.

Before implementation, every behavior-changing Tachyon Task and SDD spec declares exactly one of:

```text
Affected Product Invariants: PI-001, PI-004
Affected Product Invariants: none — <why no registered product promise can change>
```

The assessment happens during triage/specification, not after tests fail. When an invariant is affected:

1. The Task/spec links the ID and states whether the registered promise remains unchanged.
2. If the promise remains unchanged, implementation and test mechanics may evolve only under the independent-review
   equivalence rule above; the fixed oracle and its strength remain unchanged.
3. If behavior intentionally changes, a ratified product decision updates the promise, source, metadata and
   assertions together. Editing only the assertion to match new code is prohibited.
4. A materially different promise receives a new ID; the old entry is retired or superseded, never repurposed.
5. Review checks the implementation, registry and executable oracle as one change before the gate is accepted,
   and the approved authority snapshot is captured before delegation and frozen throughout it.

Documentation-only or internal mechanical changes still record `none` with a concrete reason. This makes an
omitted assessment distinguishable from a deliberate conclusion.

## Failure, flake, retry, quarantine and skip policy

A failing invariant is a product-contract failure until the implementation is corrected or an explicit product
decision changes the promise.

- Automatic retries are off by default. A diagnostic rerun may gather evidence, but a later green run does not
  erase the original failure or establish a stable pass.
- `.skip`, `.only`, conditional early returns and capability-based assertion removal are not acceptable ways to
  make a required gate green.
- A suspected flake gets an owner, reproduction evidence and a Task. Fixing determinism is preferred to retries.
- Temporary quarantine requires a linked Task, owner, reason, start date, expiry/review date and the gates that
  no longer have proof. Quarantine is visible debt, not a pass; a release depending on that invariant remains
  blocked unless the maintainer records an explicit, time-bounded product waiver.
- When a declared VS Code/tmux/Chrome/installed-system driver is unavailable, the result is **unverified**, not
  passed. The registry declares whether CI provisions the driver or release needs fresh local evidence.
- Permanent inability to run an invariant is a design failure: make the portable contract smaller, provision the
  environment, or retire/change the promise through governance.

## Gates and evidence

- **During development:** run focused regression tests for the changed mechanism and
  `npm run test:invariants` when a `PI-*` entry is affected.
- **PR/merge:** the Task/spec assessment is present, every affected invariant is green, the implementer has not
  self-approved, independent RED/GREEN/equivalence review is recorded, and promise/oracle changes cite explicit
  maintainer approval and their ratified product decision.
- **CI:** all portable Product Invariants run in a distinct visible step. The full verification also discovers
  the same files so another entry point cannot silently omit them.
- **Release:** required invariant evidence is fresh for the release candidate. Environment-bound entries attach
  their declared installed-dogfood evidence; a skipped or quarantined check is surfaced as missing proof.
- **Installed dogfood:** proves only the registered installed route and environment. It complements portable
  Product Invariant tests and never turns an unrelated exploratory pass into invariant evidence.

## Registry

### PI-001 — project-guidance ownership boundary

- **Status / owner:** active / Tachyon maintainers.
- **Promise:** project guidance is opt-in, source-labelled and absent from an unconfigured consumer's
  Tachyon primer.
- **Source:** `docs/specs/383-primer-project-guidance-boundary/spec.md`.
- **Executable evidence:** `test/product-invariants/PI-001-project-guidance-ownership.test.ts` via
  `npm run test:invariants`; active manifest entry in `test/product-invariants/registry.json`.
- **Topology:** portable integration topology through actual `AgentManager` spawn-brief composition, plus
  the pure `Tachyon: Init` generator boundary.
- **Environment / allowed variance:** supported repository Node environments on any OS; temporary directory
  roots and path separators may vary, but configured file order, bytes, source labels and absence from an
  unconfigured primer may not.
- **Fixed oracle:** no configured files produce no project guidance; explicitly configured files appear exactly
  once, in declared order, with their bytes unchanged and their declared source path before each body; Tachyon's
  tracked shared template `tachyon.yml.example` explicitly lists `docs/project-guidance.md` followed by
  `docs/architecture/product-invariant-testing.md`, and the rendered block preserves both labels and bodies;
  an unconfigured consumer's spawned brief contains the generic primer but neither that guidance nor
  Tachyon-repository policy markers; representative Node and Rust `Tachyon: Init` output contains none of
  those repository-policy markers.
- **Gates:** focused Product Invariants command, full verification and the distinct CI Product Invariants step.
- **Ratification note:** promise evidence-source updated 2026-07-19 per maintainer-ratified decision (t-8bb9cd)
  after 9186c73b untracked the live workspace config; the fixed oracle and its strength are unchanged.

### PI-002 — worktree cleanup commit safety

- **Status / owner:** active / Tachyon maintainers.
- **Promise:** a destructive worktree/branch cleanup action never discards unique, unmerged commits
  without an explicit, informed override.
- **Source:** `docs/specs/444-worktree-registry-hygiene/spec.md`.
- **Executable evidence:** `test/product-invariants/PI-002-worktree-cleanup-commit-safety.test.ts` via
  `npm run test:invariants`; active manifest entry in `test/product-invariants/registry.json`.
- **Topology:** portable integration topology through a real, disposable git repository (`git init` +
  a real committed unique change), driving the actual `ManagedWorktreeService`/`WorktreeManager`
  product code — not a fake/mocked git layer.
- **Environment / allowed variance:** supported repository Node environments with a real `git` binary
  on `PATH`, on any OS; temporary directory roots and object SHAs may vary, but the classification
  verdict and git's own branch-delete refusal may not.
- **Fixed oracle:** git ancestry. A worktree carrying a commit not reachable from (and not
  patch-equivalent to) its recorded base is never classified `ready-to-remove` by
  `classifyManagedWorktree`, and `git branch -d` on that same branch independently refuses — two
  distinct mechanisms agreeing the commit is not safe to lose, so the promise does not rest on
  Tachyon's own classifier alone.
- **Gates:** focused Product Invariants command, full verification and the distinct CI Product Invariants step.
- **Ratification note:** registered 2026-07-24 (maintainer decision, t-9f8dfc) — formalizes a safety
  property that was already an implicit design goal of spec 444's classifier and spec 365's
  `commitsNotInBase`/`forceLoseCommits` precedent.

### PI-003 — gated delegation containment is evaluated against a symbolic base

- **Status / owner:** active / Tachyon maintainers.
- **Promise:** a delegation's recorded projection base is a symbolic branch name, never a pinned
  commit, so containment tracks the trunk instead of becoming a ceiling.
- **Source:** `docs/specs/365-orchestrator-delivery-hygiene/spec.md` — "baseRef (name, not frozen
  SHA)". The promise was already ratified there; this entry makes it executable.
- **Executable evidence:** `test/product-invariants/PI-003-symbolic-delegation-base.test.ts` via
  `npm run test:invariants`; active manifest entry in `test/product-invariants/registry.json`.
- **Topology:** portable integration topology through a real, disposable git repository driving the
  actual `WorktreeManager` — not a fake git layer.
- **Environment / allowed variance:** supported repository Node environments with a real `git` binary
  on `PATH`, on any OS; temporary directory roots and object SHAs may vary. A detached workspace HEAD
  records NO base rather than substituting a pin — that fail-closed case is part of the promise, and
  the canonical gated open refuses downstream with `DELIVERY_BASE_REF_UNRESOLVED`.
- **Fixed oracle:** git's own, on both halves. A recorded base must satisfy `git check-ref-format
  --branch` AND resolve via `git show-ref --verify refs/heads/<name>`. The grammar half alone does
  not discriminate — a 40-hex SHA is a grammatically legal branch name — so resolution is what
  separates a symbolic base from a pin. Neither half is derived from the value under test.
- **Gates:** focused Product Invariants command, full verification and the distinct CI Product
  Invariants step.
- **Ratification note:** promoted 2026-07-25 (maintainer decision, t-93d073) from the property test
  landed with t-2dd637, which is removed from `test/unit/worktreeManagerRecoveryBase.test.ts` in the
  same change — two oracles for one promise drift. That file keeps its mechanism coverage. A second
  candidate assessed in the same decision ("every non-terminal lease has a governed disposition") was
  DECLINED for promotion: stating it requires enumerating the lease state machine, which is an
  internal arrangement rather than an externally observable promise, and it stays ordinary regression
  coverage.
- **Independent review — WAIVED, by maintainer decision (2026-07-25):** the implementer's own RED/GREEN
  is recorded below, and no separate reviewer signed it off. The waiver is deliberate and has a
  reason worth keeping: satisfying the review clause here would have meant spawning an AI agent, and
  the maintainer ruled that agent invocations must not become a fixed step of this project's
  governance. Recorded rather than skipped, so the gap is auditable instead of invisible.
  RED/GREEN as run by the implementer: reintroducing the t-2dd637 defect in
  `src/worktree/WorktreeManager.ts` (sourcing `baseBranch` only from `o.prior`) fails PI-003 with
  "prior-less reuse path must carry a base branch: expected undefined to be defined"; restoring it
  passes the gate at 3 invariants / 6 tests.
- **Open question this leaves for the standard itself:** the review clause above now states a
  requirement with no mechanism behind it in this repository. A requirement nobody can mechanically
  satisfy is skipped silently — the same failure this whole document exists to prevent, inverted.
  Either the clause should describe what actually happens (maintainer ratification plus recorded
  RED/GREEN, with independent review as an option rather than a precondition), or a non-agent
  reviewer path should be named. Not changed here: amending a ratified standard is a product decision,
  not an implementer's.

Adding a product-global fallback, silently reading repository guidance, dropping provenance, reordering files,
rewriting their content, or removing an active manifest/evidence link violates this invariant. A repository
remains free to choose its own guidance explicitly.
