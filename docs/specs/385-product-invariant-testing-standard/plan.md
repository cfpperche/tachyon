# 385 — Product Invariant Testing Standard — plan

_Drafted from the ratified `spec.md` on 2026-07-14._

## Approach

Create one concise architecture standard and deliver it through the already-shipped, explicit
`settings.projectGuidance.files` channel. The standard owns semantics and governance; a short section in
`docs/project-guidance.md` turns it into an operational SDD/Task convention. No global primer or generic
SDD template changes.

Register the already-ratified project-guidance ownership boundary as
`test/product-invariants/PI-001-project-guidance-ownership.test.ts`, add required metadata beside its fixed
oracle, include the directory in Vitest, expose `npm run test:invariants`, and give CI a named invariant
step. The normal full suite still includes the directory, so the focused command is a visible gate rather
than a separate source of truth. Keep the shipping classifier in the ordinary regression suite because its
component assertions do not prove the stronger packaged-artifact promise previously considered for `PI-001`.

Encode the ratified repository-governance split in the standard. Agents author and propose the promise,
metadata, oracle and evidence; an independent reviewer distinct from the implementer establishes that the
promise is stable and that the evidence has meaningful RED at the approved BASE and GREEN at HEAD; a maintainer
approves the product promise and accepted outcomes. Allow independent review alone for a mechanically equivalent
topology/runner/path change only when repository policy permits and the promise, oracle strength, accepted
variance, identity, status and gates do not change. Any weakening, removal or semantic change returns to explicit
maintainer approval, and an implementer never self-approves.

Make delegation verification project-neutral with an explicit configuration boundary:

```yaml
settings:
  verify:
    full: npm run verify:full:quiet
    typecheck: npm run typecheck
    prepare: npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
    affected: npx vitest related --run
    behavior:
      adapter: vitest-name
      command: npm test --
      stubPath: test/unit/{agent}Behavior.gen.test.ts
      executorPaths: [package.json, package-lock.json, vitest.config.ts, tsconfig.json]
```

`affected` is an argv prefix to which Tachyon appends existing changed paths as option-safe relative
arguments. A plain behavior identifier
requires `behavior`; the `vitest-name` adapter appends its name filter/JSON reporter arguments and binds the
configured compatibility `stubPath` to a **pre-existing, tracked, project-owned oracle**. Tachyon records the
oracle's committed SHA-256 at spawn, requires byte-identical oracle content at BASE and HEAD, never generates
an assertion from prose, and never adds the oracle to the implementer's ownership scope. `cmd:<command>`
remains runner-neutral and has no named oracle. `full: true` without `settings.verify.full` is an explicit
blocker, not an npm fallback.

Top-level `settings.verify.prepare` materializes a fresh runner environment in each isolated clone for
both named and `cmd:` gates. For the named adapter, `executorPaths` explicitly lists the tracked manifest,
lockfile and runner/config inputs whose committed
hashes are also fixed at spawn and checked at BASE and HEAD. The project owns both fields; Tachyon supplies
no package-manager setup command or implicit runner path.

Freeze the project's verification settings when the delegation is created, including the explicit absence
of a setting, so later config edits cannot change the verifier contract. Execute BASE and HEAD commands in
separate tracked-only clones outside the source repository, force independent Git object storage, neutralize
checkout hooks and check clean state before and after execution. Give each phase private temporary directories
and common package-cache roots. This blocks checkout-local and common implicit-cache channels without claiming
filesystem hermeticity; ambient shell/language code-injection variables are removed, while inherited
home/toolchain configuration, ordinary explicit environment variables and deliberate
absolute paths remain trusted project inputs and cannot be allowed to define the expected result.

Harden the generic Tachyon authority substrate beneath those project-selected mechanics. Seal the complete
canonical Delivery and legacy delegation authority records with workspace-domain-separated HMAC-SHA-256 using
a host-custodied secret. Pair the seal with a host-custodied freshness head outside workspace-controlled storage,
keyed by authority identity and containing the current revision/MAC, so an older valid seal cannot be replayed.
Prepare the next head durably before committing an authorized record mutation and fail closed on missing keys or
heads, tampering, stale/rolled-back revisions, identity/location mismatch and cross-workspace replay.

Capture the approved task, ownership scope, verifier settings (including absence), fixed oracle and executor hashes
before delegation. Freeze those contract fields for the entire delegation and any fixer/reuse provenance appended
to it; a changed approved contract starts a new delegation. This is generic integrity/freshness enforcement only:
consumer projects continue to choose whether they define invariants, how they approve them, and which framework,
paths, prepare command and verifier commands they use.

## Key decisions

- **Product Invariant is semantic, topology is metadata** — chosen so a promise survives changes from
  component to full-stack execution; rejected naming the suite `e2e` because that says how, not what.
- **One representative migration** — chosen to prove the convention with an existing, meaningful forcing
  function; rejected mass relabelling because most regressions are not stable product promises.
- **`PI-001` is the project-guidance ownership boundary** — chosen because it is externally observable,
  portable and directly proves that Tachyon does not impose this repository's policy on consumers. The
  VSIX classifier candidate was rejected after review because component literals did not prove the stronger
  packaged-archive promise.
- **Project guidance is the enforcement surface for agent conventions** — chosen because the repository
  owns the policy; rejected primer and generic SDD-template changes because they would impose it on users.
- **No implicit test runner** — chosen because npm, Vitest and `test/unit` are project choices; rejected
  framework detection because inference can silently choose the wrong oracle.
- **Explicit `vitest-name` adapter plus `cmd:` escape hatch** — chosen to preserve Tachyon's current
  workflow through opt-in configuration while keeping arbitrary projects neutral; rejected a universal
  generator DSL as unnecessary v1 complexity.
- **Project-owned fixed oracle for named verification** — chosen because delegation prose cannot safely
  invent expected behavior; rejected generated failing placeholders because they prove RED/GREEN mechanics,
  not the promised behavior.
- **Separated proposal, proof and product authority** — chosen so agents can do the drafting work without
  silently ratifying a new product guarantee. Independent review proves stability and RED/GREEN; maintainers
  approve the promise; implementers cannot self-approve.
- **Narrow independent approval for equivalent mechanics** — chosen so safe runner/topology maintenance does
  not require a new product decision when repository policy permits it. Any reduction in oracle strength,
  accepted outcomes, status or gates is semantic and returns to maintainer approval.
- **Frozen verifier contract and isolated source checkouts** — chosen so the implementer cannot replace a
  project command, oracle, ignored runner or shared checkout hook between spawn and verification. Phase-private
  temporary/common cache roots close implicit cross-phase state without silently replacing login/toolchain
  configuration required by arbitrary project adapters.
- **Workspace-bound HMAC plus an external freshness head** — chosen because a MAC detects forgery and mutation
  but cannot by itself detect rollback to an older valid record. The host head identifies the one current
  revision/MAC, and authority writes advance it before the workspace commit so crashes fail closed.
- **Generic enforcement, project-owned policy** — chosen so Tachyon protects the exact approved authority used by
  any configured gate without choosing a consumer's framework, commands, invariant vocabulary or approvers.
- **Preservation-only launch recovery** — chosen because even a clean-status/HEAD observation cannot exclude
  an ignored file written between the observation and a destructive remove/reset. Failed preparation leaves
  the checkout for explicit recovery. Each launch/fork/pipeline allocation uses a compatible Git worktree lock
  as a durable receipt until ownership is recorded; only an incomplete locked receipt blocks implicit reuse,
  while finalized unlocked checkouts remain reusable. Automatic orphan cleanup is deliberately traded for no
  silent data loss.
- **Commands execute as argv, not a shell** — chosen to preserve current injection resistance and exact
  behavior identifiers; configuration supplies prefixes, Tachyon appends only bounded literal arguments.
- **No global full/affected fallback** — chosen for honest absence; rejected `npm test`/`npx vitest related`
  compatibility defaults because they are exactly the product-to-project policy leak being removed.

## Files touched

- `docs/architecture/product-invariant-testing.md` — normative standard, registry and `PI-001` declaration.
- `docs/project-guidance.md`, `tachyon.yml`, `README.md` — operational convention, explicit delivery and developer commands.
- `test/product-invariants/PI-001-project-guidance-ownership.test.ts` — representative invariant and metadata.
- `test/unit/cxShipBoundaryBehavior.gen.test.ts` — unchanged ordinary shipping-classifier regression.
- `vitest.config.ts`, `package.json`, `.github/workflows/ci.yml` — discovery and focused/CI gates.
- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json`, `src/config/argvCommand.ts`,
  `src/config/behaviorVerification.ts` — project-owned verification adapter contract.
- `src/bridge/behaviorStub.ts`, `src/bridge/verifyTask.ts`, `src/bridge/tools.ts`, `src/workspace/Workspace.ts` — neutral command path and configured named-test path.
- `src/delivery/authorityIntegrity.ts`, `src/delivery/store.ts`, `src/delivery/types.ts`,
  `src/bridge/delegationRecord.ts` — workspace-bound HMAC seals, host freshness heads and frozen durable authority.
- `src/agents/AgentManager.ts`, `src/worktree/WorktreeManager.ts` — ownership-safe launch compensation
  without deleting work after runtime ownership becomes ambiguous.
- `test/unit/config.test.ts`, `test/unit/configSchema.test.ts`, `test/unit/deliveryStore.test.ts`, `test/unit/verifyTask.test.ts`,
  `test/unit/workspaceHeadless.test.ts`, `test/unit/snBoundaryLocksBehavior.gen.test.ts` — regression matrix.
- `docs/architecture/dogfood-product-boundary.md` — registry updated from implicit defaults to explicit project ownership.
- `docs/specs/385-product-invariant-testing-standard/*` — intent, plan, tasks and evidence.

## Risks & unknowns

- Legacy persisted delegations that have neither a verifier snapshot nor an oracle hash cannot establish the
  new named-oracle proof and must be restarted or use an explicit coordinator-owned migration path.
- Legacy or canonical authority without both a valid host HMAC key and current external freshness head cannot be
  trusted automatically. Explicit import/retirement is safer than treating workspace-controlled history as current.
- Configurable oracle paths must reject absolute/traversal/backslash/`.git` paths, require `{agent}`, reject
  symlinks, and resolve to a clean, tracked file whose checkout bytes equal committed HEAD at spawn.
- Verification clones are disposable and locally owned; cleanup must be marker- and process-identity-safe so
  one verifier cannot reap another live verifier's checkout.
- HMAC key loss, freshness-head write failure or a crash between head preparation and workspace commit must block
  authority use and surface recovery rather than silently accepting an older signed snapshot.
- Verification is process/check-out isolation, not a general filesystem sandbox. Project commands that read
  inherited home/toolchain state, explicit shared environment variables or absolute external paths treat those
  as trusted adapter inputs; an invariant oracle must never be derived from them.
- CI must not accidentally omit Product Invariants from `verify:full`; the main Vitest include remains the
  aggregate source and the focused CI step filters the same files.
- The installed VS Code host suite stays local-only due the documented tmux-version constraint. It cannot
  be presented as CI evidence, and `PI-001` deliberately has portable integration topology.
- The main workspace has unrelated user edits in `tachyon.yml`; final integration must preserve them and
  add only the new guidance/config entries.

## Visual impact

None. This changes repository policy, configuration and headless verification; no rendered UI surface.

## Sources consulted

- `docs/architecture/dogfood-product-boundary.md`, SDD 383 and the existing project-guidance boundary.
- `src/bridge/behaviorStub.ts`, `src/bridge/verifyTask.ts`, `src/bridge/delegationRecord.ts`,
  `src/workspace/Workspace.ts`.
- `src/delivery/authorityIntegrity.ts`, `src/delivery/store.ts`, `src/delivery/types.ts`.
- `vitest.config.ts`, `.github/workflows/ci.yml`, `.vscode-test.mjs`, `scripts/verify-full.mjs`.
- Spec 383 project-guidance ownership boundary and specs 362/363 verification/onboarding contracts.
- Task `t-2b8808` and the maintainer's terminology decisions leading to it.
