# 385 — Product Invariant Testing Standard

_Created 2026-07-14. Task: `t-2b8808`._

**Status:** shipped
**Closure:** Shipped 2026-07-15 — repository-owned Product Invariant standard and PI-001 gate;
project-neutral verifier configuration; authenticated, fresh delegated authority; preservation-only
launch recovery; independent RED/GREEN and security closure; full verification green.
**Affected Product Invariants:** `PI-001` (created and adopted by this decision)

## Intent

Tachyon has many regression tests, but their names and locations do not distinguish a change-scoped
regression guard from a stable, externally observable product promise. Calling the missing layer `e2e`
would also conflate semantics with topology: a Product Invariant may run through a component, an
integration, a full stack, or an installed system while protecting the same promise.

Define the repository-owned Product Invariant Testing Standard, make it part of Tachyon's explicit
project guidance, and adopt one representative invariant without relabelling the whole suite. At the
same boundary, stop the Tachyon product from silently choosing npm, Vitest, or `test/unit` for consumer
projects' gated delegations: the project owns verification commands and any named-test adapter; Tachyon
only executes the declared mechanics and keeps the expected behavior fixed. Harden that generic authority
boundary with a workspace-bound, host-custodied HMAC and a host-custodied freshness head, while leaving
framework selection and invariant/approval policy entirely with each consumer project.

## Acceptance criteria

- [x] **Scenario: the semantic category is stable while topology may vary**
  - **Given** the canonical Product Invariant Testing Standard
  - **When** an agent classifies unit, integration, browser/full-stack, installed dogfood, and Product Invariant checks
  - **Then** Product Invariant means a stable externally observable promise, while `e2e` and `full-stack` describe only execution topology
  - **And** runner adaptation may discover environmental mechanics but may not derive or change the expected promise or oracle
- [x] **Scenario: invariant changes require a product decision**
  - **Given** a declared `PI-*` promise and fixed oracle
  - **When** behavior intentionally changes
  - **Then** a spec/product decision names the affected invariant and changes its promise, metadata, and assertions together
  - **And** merely editing the assertion to match new code is explicitly prohibited
- [x] **Scenario: authorship, proof and product approval are separate authorities**
  - **Given** an agent-authored proposal for a new or changed Product Invariant
  - **When** the proposal is considered for activation
  - **Then** an independent reviewer distinct from the implementer proves that the promise is stable and the executable oracle has meaningful RED/GREEN evidence
  - **And** a maintainer, not the implementer acting alone, approves the product promise and accepted outcomes
  - **And** the implementer cannot self-approve either the implementation or the equivalence/RED/GREEN proof
- [x] **Scenario: equivalent mechanics do not silently change the promise**
  - **Given** an approved invariant whose promise, accepted outcomes, allowed variance, strength, identity and active status remain unchanged
  - **When** only its topology, runner, path or equivalent executable mechanics change
  - **Then** independent review may approve the mechanical change when repository policy permits
  - **And** weakening, removing or changing the promise/oracle, or reducing its gates, always requires explicit maintainer approval
- [x] The standard defines stable IDs; required metadata and source; allowed environmental variance;
      fixed oracles; change governance; flake, retry, quarantine and skip policy; and PR, merge/release,
      and installed-dogfood gates.
- [x] The standard distinguishes unit, integration, Product Invariant, and dogfood responsibilities and
      documents local-only VS Code/tmux/Chrome system-driver limitations without presenting a skip as proof.
- [x] **Scenario: Tachyon opts in without imposing its standard on consumers**
  - **Given** this repository's `tachyon.yml`
  - **When** project guidance is composed
  - **Then** it explicitly includes `docs/architecture/product-invariant-testing.md` with source provenance
  - **And** an unconfigured consumer, the global primer, and `Tachyon: Init` contain none of this repository policy
  - **And** generic authority hardening chooses no consumer test framework, invariant vocabulary, command or approval workflow
- [x] Every behavior-changing Tachyon Task and SDD spec must state `Affected Product Invariants: PI-*`
      or `none — <reason>`; the project guidance carries this short operational rule without modifying
      the consumer-generic SDD skill templates.
- [x] **Scenario: the first invariant is executable through the dedicated gate**
  - **Given** `PI-001`, the project-guidance ownership promise
  - **When** `npm run test:invariants` runs
  - **Then** its fixed absence, source-label, order and byte-preservation oracle executes from `test/product-invariants/**`
  - **And** the normal full verification includes it while CI exposes a distinct Product Invariants step
- [x] **Scenario: command verifiers are project-neutral**
  - **Given** a gated delegation whose `behavior_test` starts with `cmd:`
  - **When** Tachyon creates the worktree and later verifies it
  - **Then** it executes that explicit argv command and creates no language- or runner-specific stub
- [x] **Scenario: named behavior tests require an explicit project adapter**
  - **Given** a workspace without `settings.verify.behavior`
  - **When** a gated delegation supplies a plain behavior-test name
  - **Then** Tachyon fails with a configuration diagnostic and creates no implicit Vitest/`test/unit` artifact
  - **And** when the workspace explicitly selects the Vitest-name adapter, Tachyon uses only its configured command and `{agent}` oracle-path template
  - **And** the oracle must already be a tracked project-owned file whose committed SHA-256 stays byte-identical at BASE and HEAD; Tachyon never generates a placeholder from prose or adds the oracle to implementer ownership
- [x] **Scenario: delegated authority is authenticated and fresh**
  - **Given** a canonical Delivery or legacy gated delegation whose project-owned contract has been approved and captured
  - **When** Tachyon persists, resolves, mutates or verifies its authority
  - **Then** the complete workspace-bound authority record is authenticated with host-custodied HMAC-SHA-256 and checked against a host-custodied current revision/MAC freshness head
  - **And** unsigned, stale, tampered, rolled-back, misplaced or cross-workspace replayed authority fails closed before verification or execution is trusted
  - **And** the approved task, scope, verifier settings, oracle and executor snapshot stays frozen for the delegation's lifetime, including fixer/reuse rounds
- [x] `verify_task` has no implicit full-test or affected-test npm/Vitest command; those tiers run only
      from `settings.verify.full` and `settings.verify.affected`, with missing requested configuration
      surfaced honestly rather than replaced by a product-global project assumption.
- [x] Schema, configuration parser, README, architecture registry, focused tests, typecheck,
      `npm run test:invariants`, SDD dogfood, and `npm run verify:full:quiet` are green.

## Non-goals

- Mechanically relabelling the existing unit/integration/browser suites as Product Invariants.
- Requiring every Product Invariant to use a browser, VS Code host, real tmux, or installed VSIX topology.
- Building a universal test-runner plugin API in this iteration; v1 supports explicit `cmd:` verifiers
  and one opt-in Vitest-name adapter without making either a consumer default.
- Moving Tachyon's `PI-*` convention into the global primer, `Tachyon: Init`, or the generic SDD skill templates.
- Using generic HMAC/freshness enforcement to prescribe a consumer's invariant vocabulary, test framework,
  verification command or human/agent approval policy.
- Treating headless Product Invariant execution as a substitute for installed dogfood when the promise
  depends on an installed-system driver.

## Open questions

None. The task contract and repository audit ratified project-guidance ownership as `PI-001`, explicit
verification commands, a single opt-in Vitest-name adapter, the separated author/reviewer/maintainer role
model, and generic workspace-bound HMAC plus host freshness enforcement for delegated authority.
