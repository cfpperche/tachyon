# 425 — Agent profile resolver — plan

_Drafted from `spec.md` on 2026-07-22._

## Approach

Build the resolver as a pure boundary beside the existing `tachyon.yml` parser. Keep file custody,
schema validation, precedence and provenance in small modules so later migration and runtime adapters
consume one contract rather than duplicate policy.

1. Define strict V1 wire schemas and exported semantic/provenance/error types. Unknown keys and future
   schema versions fail before any normalized value is emitted.
2. Add one bounded descriptor-rooted reader for the canonical profile and declared local references.
   It opens each directory from a retained parent descriptor, keeps the exact profile directory open,
   and validates component kinds, descriptor identity, revisions and exact-byte digests.
3. Normalize canonical and legacy inputs through separate adapters into the same secret-unresolved
   semantic result. The top-level resolver chooses exactly one owner and rejects double authority;
   opaque legacy values and validated reference bytes never enter the public result.
4. Resolve only explicitly named inheritance and join caller-supplied project-guidance provenance.
   Require a host profile-head snapshot plus an exhaustive, versioned native-input inspector
   attestation; treat runtime-native/private-home observations as conflicts or proven-suppressed facts,
   never values.
5. Add focused unit tests plus PI-001. Do not wire the resolver into `Workspace.reloadConfig`,
   `AgentManager` or `HarnessManager`; `t-4f82e0` owns that cutover and migration.

## Key decisions

- **Conventional path in this slice** — chosen so one loader can be implemented before YAML pointer
  migration; rejected adding `profile:` to `tachyon.yml` because that is explicitly owned by `t-4f82e0`.
- **Normalized semantic value, not `ManagedEntryDef`** — chosen because model/provider, references and
  provenance do not fit the current opaque command-centric shape; rejected extending the legacy type
  into a second accidental canonical schema.
- **Legacy adapter without synthetic authority** — chosen because compatibility stanzas have no
  immutable `agentId`; rejected deriving an id from name/path because rename or reuse could inherit
  stale authority.
- **Caller-supplied external facts** — chosen for workspace defaults, guidance and runtime-native
  observations so the resolver remains deterministic and testable. The trusted caller must provide a
  host-custodied profile head and digest-bound exhaustive adapter attestation; rejected an optional
  observation list because omission would fail open. Rejected reading ambient process env or private
  runtime homes as values because that would make projections canonical inputs.
- **Structured errors with stable codes** — chosen so config reload, Studio and future migration can
  present the same cause; rejected relying on free-form thrown strings as the API.
- **Exact-byte digest plus canonical semantic digest** — chosen to distinguish source mutation from
  equivalent normalized meaning; rejected a semantic digest alone because it cannot bind consumed
  references.
- **No cache or LKG inside the resolver** — chosen so every call reflects one explicit input snapshot;
  rejected silently returning a prior result because reload failure must remain visible and fail closed.

## Files touched

| Path | Purpose |
|---|---|
| `src/config/agentProfileSchema.ts` | Strict V1 wire schema and semantic types |
| `src/config/agentProfileReader.ts` | Bounded, contained, descriptor-bound file/reference reads |
| `src/config/agentProfileResolver.ts` | Owner selection, normalization, inheritance, conflict checks and provenance |
| `test/unit/agentProfileResolver.test.ts` | Resolver, path, mutation, conflict, redaction and determinism coverage |
| `test/product-invariants/PI-001-project-guidance-ownership.test.ts` | Only if composition setup needs extension; fixed oracle remains unchanged |
| `docs/specs/425-agent-profile-resolver/*` | Intent, plan, tasks and execution evidence |

`src/config/loadConfig.ts`, `src/config/tachyon.schema.json`, `src/workspace/Workspace.ts`,
`src/agents/AgentManager.ts` and `src/harness/HarnessManager.ts` are deliberately not modified unless
implementation proves a minimal shared helper extraction is necessary. Any behavioral wiring into
those consumers moves to `t-4f82e0`.

## Risks & unknowns

- Node lacks `openat`; the reader uses a verified host descriptor filesystem (`/proc/self/fd` or
  `/dev/fd`) plus required no-follow/directory/nonblocking flags. A host without this boundary is
  explicitly unsupported for canonical resolution in V1 and fails closed.
- Existing legacy `cmd`/`env` can contain shell wrappers, selectors or arbitrary credentials. The
  public compatibility result exposes only command digest and environment names; the old launch path
  retains private values until migration can classify them safely.
- Secret-reference identifiers can themselves reveal provider/account relationships. Diagnostics need
  redaction even though values are never resolved here.
- Project guidance already has hardened path reads. Reusing its rendered bundle avoids a second read
  path and protects PI-001 ordering/provenance.
- A normalized result that is not yet wired can drift before migration. Public tests and the next task's
  dependency keep the contract explicit; no parallel runtime implementation should invent another type.

## Visual impact

**Visual QA Opt-Out:** loader/resolver and tests only; no rendered surface changes in this slice.

## Sources consulted

- `docs/specs/423-agent-profile-contract/spec.md` and `plan.md` — ratified ownership, precedence,
  reference and plugin boundaries.
- `.tachyon/reports/agent-persistent-formation-inventory-2026-07-21.md` — current-source inventory and
  runtime/private-home ambiguity.
- `src/config/loadConfig.ts` and `src/config/tachyon.schema.json` — legacy `ManagedEntryDef`, workspace
  settings and parser behavior.
- `src/config/projectGuidance.ts` and `test/product-invariants/PI-001-project-guidance-ownership.test.ts`
  — hardened shared guidance and fixed ownership oracle.
- `src/agents/AgentManager.ts`, `src/harness/HarnessManager.ts` and `src/agents/promptLayers.ts` — current
  runtime consumers and generated projection boundary.
