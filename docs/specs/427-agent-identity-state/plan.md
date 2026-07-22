# 427 — Agent identity and learned-state formation — plan

_Drafted from `spec.md` on 2026-07-22. Implementation starts only after an adversarial probe accepts
the authority/snapshot state machine._

## Approach

Deliver vertical slices rather than horizontal stores:

1. Build the shared authority/snapshot foundation with no newly enabled lane: profile-head v2 schema,
   transactional formation-generation store, compatibility reader, host-owned content-addressed
   snapshot store, revision-vector predicate/read barrier, recoverable snapshot publication,
   session-selector authorization/idempotency and operation-transition validator. Characterize legacy
   bytes and plugin calls.
2. Enable Soul and Persistent Instructions through that complete path: schema/reference resolution,
   governed migration, primary-identity binding, immutable snapshot payload, resume/fork semantics and
   lane-local lifecycle hooks.
3. Enable Evolution only after its active state is represented by one complete host-authorized
   inventory. Capture learning plus every skill artifact into the same immutable session payload.
4. Add human-approved selected memory with a separate manifest/head/promotion endpoint and a
   versioned adversarial-safe renderer. There is no runtime-managed mutation endpoint.
5. Run cross-lane consistency, lifecycle integration-contract, migration, PI-001, plugin
   non-interference and isolated end-to-end dogfood. Hand the stable lane APIs to `t-e50d4f`.

## Key decisions

- **One enabled state: required** — rejected optional enabled lanes because a stale/tampered identity
  source must not silently disappear from the effective agent.
- **Host head records mode and authority** — rejected runtime inference from workspace files; canonical
  corruption never falls back to legacy.
- **Immutable payload contains the delivered bytes/artifacts** — rejected digest-only snapshots because
  resume cannot reconstruct changed or deleted source content.
- **One authorized formation generation plus read barrier** — rejected a merely stable vector because
  independently valid lane heads may never have been authorized as one combination.
- **Durable objects first, selector transaction last** — rejected claims of cross-store atomicity;
  prepared payloads are unselectable and GC is fenced by publication/fork leases.
- **Authenticated, idempotent fresh-session creation** — owner/session/trust class are derived by the
  host; request payloads cannot transfer identity or replay a launch into a second selector.
- **Operation-specific selector transitions** — rejected grouping resume/rebind/re-anchor/fork because
  they have different ownership and identity-transfer risks.
- **Evolution head owns a complete active inventory** — rejected `profile.json` or directory discovery
  as authority.
- **Human-approved memory only** — rejected runtime-managed memory in this SDD because bounded text is
  still durable prompt-writing power; the later design needs separate ratification.
- **427 supplies lane operations; `t-e50d4f` orchestrates lifecycle** — rejected competing cross-store
  journals and recovery ownership.
- **Plugins are outside formation** — snapshots and lifecycle never enumerate, suppress, copy or restore
  plugin state; explicit characterization protects the current workspace behavior.

## Vertical task decomposition

- Foundation task: authority v2, immutable object store, session selector/read barrier and compatibility.
- Human task: Soul/instructions migration and exact session delivery.
- Evolution task: primary identity, complete active inventory and pinned skills.
- Memory task: human-approved selected text and renderer.
- Integration task: cross-lane dogfood, lifecycle consumer contract and documentation.
- Separate deferred task/spec: runtime-managed memory delegation/autopromotion.

Each task owns disjoint modules where possible and includes migration, resume/fork and tamper tests for
the lane it enables. No task may expose an enabled selector before its full snapshot path is available.

## Expected files

- Profile/authority: `src/config/agentProfileAuthority.ts`, schema/resolver/projection and SecretStorage adapter.
- Formation: new `src/agents/formation/{domain,objectStore,resolver,sessionSelector}.ts` plus AgentManager integration.
- Human lanes: Soul modules plus new bounded `persistentInstructions.ts` and migration transaction.
- Evolution: domain/store/startup snapshot upgraded to complete `agentId`-bound inventory.
- Memory: new `src/memory/{domain,store,renderer}.ts` and human-promotion service operations.
- Session: `SessionLedger.ts`, startup manifest/provenance and operation validators.
- Lifecycle: lane-local interfaces only; `t-e50d4f` owns the cross-lane coordinator.
- Tests: characterization first, then authority/replay/tamper/race/recovery/session/plugin matrices.

## Verification strategy

- Byte-pin existing legacy/disabled prompt composition before edits.
- Fault-inject every authority/object-store/selector publication boundary.
- Race every authority head during fresh resolution and prove whole-vector retry.
- Delete/mutate source bytes after snapshot and prove exact resume/fork payload behavior.
- Exercise duplicate native delivery, unsupported suppression and runtime trust-class changes.
- Prove Evolution cannot traverse governance paths and memory cannot discover raw runtime state.
- Compare plugin discovery/injection calls and materialized bytes across lanes and lifecycle hooks.
- Run PI-001, focused suites, typecheck and configured full verification after each vertical slice.

## Risks

- Host-owned immutable storage and selector retention need bounded cleanup without deleting resumable
  payloads. Reference counting must be derived from authoritative selectors, never workspace ledgers.
- Existing Soul/Evolution stores have separate recovery protocols; adapters must expose exact immutable
  reads without merging authority or weakening current promotion semantics.
- Profile authority v1 data exists. Upgrade must be explicit and compatible; unknown/corrupt v2 state
  cannot downgrade to v1 or legacy.
- Full lifecycle behavior cannot be tested end to end until `t-e50d4f`; this SDD must provide a stable
  idempotent contract and an integration fixture without claiming orchestration ownership.

## Visual impact

No new custom UI. Existing Agent Studio sections remain separate. `t-e50d4f` owns any later unified
lifecycle UI and its visual QA.

## Sources consulted

- `docs/specs/423-agent-profile-contract/{spec,plan,notes}.md`
- `docs/specs/421-agent-evolution/{spec,plan,notes}.md`
- `docs/specs/426-agent-profile-migration/*`
- `src/config/agentProfile{Schema,Resolver,Projection,Authority}.ts`
- `src/agents/{soul,soulProfileTransactions,promptLayers,AgentManager,startupBrief}.ts`
- `src/evolution/{domain,EvolutionStore,startupSnapshot}.ts`
- `src/resume/SessionLedger.ts`
- Probe `probe-94a126a0-e794-4b14-b18c-abcdab5dd83f`
