# 427 — Agent identity and learned-state formation

_Created 2026-07-22._

**Status:** shipped

**Closure:** Shipped 2026-07-22 as the complete host-authorized formation foundation and four lane
implementations: Soul, Persistent Instructions, approved Evolution and human-approved selected
memory resolve into one immutable fresh-session snapshot with pinned resume/re-anchor/fork bytes.
PI-001, focused matrices, isolated dogfood, typecheck and full verification (476 files; 5,390 passed,
3 skipped) are green. Residual scope is intentionally separate: cross-lane lifecycle orchestration
and UI (`t-e50d4f`), runtime-native memory architecture (`t-d4c42e`) and agent-scoped plugins.

## Intent

The canonical `agent.yml` can describe runtime and operational policy, but profile-backed agents still
cannot safely consume the durable inputs that most directly form a future session: Soul, Persistent
Instructions, approved Agent Evolution and selected memory. Those sources already have partial
implementations, yet selectors still live in `tachyon.yml`, subordinate identities bind mainly to a
mutable name, and resume/fork do not select one immutable snapshot of all delivered bytes.

This contract makes `.tachyon/agents/<agent>/` the inspectable ownership root while keeping authority
outside that writable tree. It delivers the work as end-to-end lane slices: shared formation authority
and immutable snapshot storage first, then Soul/instructions, Evolution, and human-approved selected
memory. Runtime-managed memory is explicitly deferred to its own later spec because it delegates
durable prompt-writing power and needs an independently ratified authority contract.

Affected Product Invariants: **PI-001 — promise and fixed oracle unchanged.** Project Guidance remains
project-owned, opt-in, lossless and ordered in the same prompt position. Legacy and disabled behavior
must remain byte-compatible.

## Canonical source layout

```text
.tachyon/agents/<agent>/
├── agent.yml                 # untrusted source; human definition and lane selectors
├── SOUL.md                   # human identity source
├── instructions.md           # human operating-instruction source
├── evolution/                # existing Evolution workspace projection/governance
│   ├── profile.json
│   ├── LEARNINGS.md
│   ├── skills/
│   ├── candidates/           # never formation input
│   ├── reviews/              # never formation input
│   └── history/              # never formation input
├── memory/
│   ├── manifest.json         # human-approved selected-text inventory
│   ├── active/               # selected bounded text only
│   └── candidates/           # never formation input
└── snapshots/                # optional inspectable projections; never authority/payload source
```

Files prove content identity only. They do not authorize themselves. No automatic discovery adopts a
pre-existing source, selector, subordinate manifest or directory.

## Normative authority graph

Host custody has five record classes in one transactional `FormationAuthorityStore`. Lane heads retain
their distinct mutation predicates, while one formation-generation record authorizes the only
combination that may be snapshotted:

### `ProfileActivationHeadV2`

The existing host profile authority evolves to a record containing:

- `schemaVersion`, strictly monotonic `revision`, workspace identity and immutable `agentId`;
- mutable `agentName` locator and exact `agent.yml` digest;
- runtime inspector identity/version/executable-contract digest;
- one closed mode for each formation lane: `legacy`, `disabled`, or `profile`;
- for every `profile` lane, `required: true`, selector id/path, source digest and renderer contract id;
- resulting effective profile digest and prior revision used by CAS.

There are no optional enabled lanes in V1. `profile` means required: any missing bytes, identity
mismatch, stale authority or renderer failure blocks the whole fresh launch. `disabled` means the lane
is intentionally absent. A workspace edit cannot change mode or effective state. Only a trusted
human/profile mutation operation may replace the head after validating exact source bytes, lane
authorities and CAS against the current revision.

### `EvolutionActivationHeadV2`

This is the sole authority for active Evolution state. It binds `agentId`, subordinate `profileId`,
version, exact `profile.json` digest, learning digest, a complete sorted inventory of skill-relative
paths/content digests/executable bits, promotion revision and predecessor revision. Workspace
`profile.json` is an untrusted projection/selector, not authority.

Only the existing human approval promotion may CAS-replace this head. Active files must be
manifest-enumerated regular files below fixed `LEARNINGS.md` and `skills/` roots, opened component by
component without following symlinks. Paths into `candidates`, `reviews`, `history`, intents or an
external root are rejected.

### `MemoryActivationHeadV1`

V1 selected memory is **human-approved only**. The head binds `agentId`, profile-head revision,
strictly monotonic memory revision, exact manifest digest, a complete sorted inventory of active text
paths/content digests, renderer contract id/digest and predecessor revision. Only a trusted human
promotion may replace it. `disabled` consumes no memory and requires no memory head.

Runtime-managed delegation/grants, adapter autopromotion and raw runtime memory import are not part of
SDD 427. They require a separate task/spec and cannot reuse the human-approved head mutation endpoint.

### `FormationGenerationHeadV1`

This is the sole authority for the complete active formation tuple. It binds `agentId`, a strictly
monotonic generation, retirement state, exact `ProfileActivationHeadV2` revision/digest and, according
to each profile lane mode, the exact `EvolutionActivationHeadV2` and `MemoryActivationHeadV1`
revision/digest or explicit absence. It also binds every renderer/suppression contract required by the
tuple.

The vector predicate is closed:

- all records bind the same non-retired `agentId` and workspace;
- each profile selector id/subordinate id equals the referenced lane head subject;
- `profile` mode requires the exact head named by the generation; `disabled` requires no referenced
  active head (residual historical records are audit-only); `legacy` is legal only before canonical cutover;
- source/manifest inventories and renderer contracts equal the digests bound by their referenced heads;
- no head with a different generation, stale predecessor, preparing/revoking state or mutable name-only
  match is compatible.

Profile edit, Evolution promotion and memory promotion each prepare their lane-specific bytes/head,
then atomically CAS the lane head and `FormationGenerationHeadV1` in one authorized store transaction.
The old complete tuple remains active until that commit; an unreferenced prepared head has no effect.
Fresh resolution validates the vector predicate before reading sources and again immediately before
snapshot publication.

### `FormationSessionSelectorV1`

A host-custodied selector binds `sessionId`, `agentId`, authenticated owning principal, runtime trust
class, snapshot id/digest, profile/evolution/memory authority revisions and optional fork lineage. It
is the only authority that selects bytes for resume, rebind, restart, re-anchor or same-snapshot fork.
Workspace ledgers may mirror it but cannot mint or replace it.

Host records are replaced only by their named trusted operation. CAS proves freshness but never grants
authorization. No API reachable by an agent/runtime principal may authorize human definition, Soul,
instructions, Evolution promotion, memory promotion or session ownership transfer.

`createFreshFormation` is the only selector-creation operation. It receives an authenticated caller
from the existing Bridge/engine boundary plus a declared agent, verifies the existing managed-launch
policy for that caller/agent, derives the owner from authenticated identity (never request payload),
assigns the server-side session UUID and runtime trust class, and atomically check-and-creates by a
caller-supplied bounded idempotency key. Replay returns the same selector only for the exact same
caller/agent/request digest; conflicting reuse fails. Runtime principals may request launch through
their existing authorized surface but cannot choose owner, `agentId`, trust class or selector fields.
Fork creation repeats authorization, requires the same owner/agent/trust class and uses its own
idempotency key. Security revocation is a host operation over owner/agent/session selectors.

## Resolution and atomic fresh launch

Each agent has one authority-recorded mode; sources never choose precedence:

- A legacy agent resolves all existing inline lanes exactly as before and has no canonical fallback.
- A canonical agent resolves only modes recorded in `ProfileActivationHeadV2`; corrupt profile bytes
  never fall back to legacy `tachyon.yml`.
- Migration uses a durable host-owned intent with `prepared`, `pointer-written`, `committed` and
  `compensating` states. Creating the intent blocks fresh launch for that `agentId`. It prepares
  unreferenced profile/lane heads and source bytes, writes and fsyncs the exact profile pointer, then
  atomically commits profile mode plus `FormationGenerationHeadV1`; that host transaction is the sole
  cutover point. Recovery before commit restores the exact legacy stanza and retires prepared heads;
  recovery after commit finishes the canonical tuple. Corrupt/missing intent or post-commit pointer
  fails closed and never falls back to v1 authority or legacy.

Fresh launch uses an optimistic read barrier:

1. capture the current non-retired `FormationGenerationHeadV1` generation/digest plus its exact
   profile, Evolution and memory authority revision vector;
2. open and validate every bounded source with no-follow descriptor-relative reads;
3. materialize canonical prompt bytes and Evolution skill artifacts into immutable host-owned
   content-addressed objects;
4. re-read the entire authority vector; any change restarts the whole resolution;
5. publish the immutable snapshot through the prepare/commit protocol below, conditional on that
   exact formation generation still being current and compatible.

No partial snapshot is selectable. Native runtime capability negotiation declares, for each formation
lane, that Tachyon owns delivery and the runtime-native equivalent is absent/suppressed. The snapshot
binds adapter/inspector version, suppression decisions and acknowledgement. Unsupported, duplicate or
partially suppressed delivery blocks launch.

## Immutable snapshot payload

The host-owned `AgentFormationSnapshotV1` is not stored under the workspace profile. It contains or
addresses immutable content objects for:

- the exact fully rendered startup prompt bytes, canonical encoding, layer order and renderer version;
- the exact fully rendered re-anchor formation-reminder bytes, framing and digest;
- each source layer's owner, type, source digest and delivered byte range/digest;
- every active Evolution skill file, relative path, bytes digest and executable bit;
- `agentId`, profile/evolution/memory revision vector, runtime trust class and suppression evidence;
- snapshot id, complete manifest digest and creation time.

Content objects and the manifest are retained while any live/resumable session or fork selector
references them. Missing, mutated or incomplete payload fails deterministically; a digest alone never
attempts to reconstruct deleted source bytes. Workspace snapshot files and runtime projections are
inspectable caches only.

Snapshot publication is recoverable, not a cross-filesystem fiction. The host object store first
writes content-addressed objects to private staging, fsyncs each file and parent, publishes immutable
objects by digest, then records a `prepared` manifest plus in-flight GC lease. One transaction in the
`FormationAuthorityStore` conditionally inserts the committed manifest row and
`FormationSessionSelectorV1` together only while the captured non-retired
`FormationGenerationHeadV1` generation/digest remains current and satisfies the vector predicate;
generation mismatch aborts publication and restarts complete resolution. Snapshot manifest and
selector both bind that generation/digest. Selectors can reference only committed rows whose complete
object inventory already exists. The operation is idempotent by launch key. Recovery deletes abandoned
prepared manifests/objects only after proving no committed selector or live publication/fork lease
references them. GC takes the same lease barrier and derives reachability only from committed host
selectors/manifests, never workspace ledgers.

## Session operation semantics

- **Fresh launch:** creates a new `sessionId`, immutable payload and selector after the complete read
  barrier. Any formation-affecting runtime/model/role/policy change requires this operation.
- **Restart:** same session/principal/agent/runtime trust class; reuses exact selected payload.
- **Resume:** same session/principal/agent/runtime trust class; reuses exact selected payload and
  verifies selector/payload integrity. It never resolves current profile sources.
- **Rebind:** may restore transport/process ownership only for the same authenticated principal,
  `sessionId`, `agentId` and runtime trust class. Cross-agent, cross-principal and formation-affecting
  runtime changes are forbidden.
- **Re-anchor:** delivers only the exact formation-reminder bytes and framing content-addressed by the
  selected immutable payload; it never rerenders them with current code/configuration. Existing
  task/continuity delivery remains a separate unchanged session-contract input and
  cannot contribute Soul, persistent instructions, role, Evolution, memory, tools or policy to the
  formation reminder. SDD 427 neither expands its writers nor changes its framing.
- **Same-snapshot fork:** creates a new session/fork selector, records parent lineage and keeps the same
  principal, `agentId`, runtime trust class and snapshot. A different runtime trust class or identity
  requires a fresh launch.

Retirement or explicit security revocation blocks all operations. Content updates alone do not mutate
an existing session.

## Lane contracts

### Soul and Persistent Instructions

Soul keeps its human create/import/adopt/replace workflow and limits. Its manifest gains `agentId` while
retaining subordinate `profileId` and mutable owner. Persistent Instructions move from inline YAML to
bounded UTF-8 `instructions.md` through a governed source-digest/CAS transaction. They remain distinct
from Soul, role, Project Guidance, task instructions and Evolution.

When either lane is `profile`, its exact bytes are required by the profile head and fresh launch. A
missing/mismatched source fails the whole launch; it is never silently omitted. Existing canonical
profiles with absent/disabled lanes remain unchanged.

### Evolution

Evolution keeps proposal/review/history and human approval semantics. Approval produces a new complete
active inventory and `EvolutionActivationHeadV2`; only that tuple may enter a fresh snapshot. Pending
or rejected candidates, reviews, history and recovery intents are structurally excluded.

### Human-approved selected memory

The manifest lists bounded UTF-8 text entries under `memory/active/`, their provenance and digests.
Only a human promotion may activate a candidate. Selected memory is labelled as learned context and
may influence future behavior; it is not described as semantically non-executable. It cannot declare
tools, skills, hooks, MCP, environment, role or executable files. Exact renderer framing, escaping and
byte/entry quotas are versioned and tested with adversarial text.

Raw transcripts, runtime databases/indexes, continuity and arbitrary files are neither read nor
copied.

## Lifecycle ownership

SDD 427 owns lane-local operations only: validate/prepare exact bytes, bind/unbind `agentId`, import as
inactive candidate, retire lane authority and report idempotent status. `t-e50d4f` alone owns the
cross-lane lifecycle intent, ordering, journaling, recovery and user-visible rename/clone/forget state.

- Rename orchestration enters a host `relocating` state, blocks fresh launch, preserves existing
  session selectors, moves only profile-owned roots, updates mutable locator metadata and CAS-commits
  a new profile revision. Lane operations never move external references or plugin paths.
- Clone imports human Soul/instructions as new-identity sources. Learned bytes, when explicitly chosen,
  enter destination candidate roots with source identity/digests and require destination human review;
  active directories, authorities, reviews/history and session snapshots are never copied.
- Forget orchestration retires every authority for `agentId` before canonical bytes are quarantined or
  removed. Name reuse always receives a new identity.

## Plugin exclusion boundary

Plugin availability, installation, selectors, runtime injection and plugin-owned paths are not
formation inputs or lifecycle children. A formation snapshot cannot pin, suppress, restore or narrow
plugin state. Native-input attestation added here covers only the four profile-governed lanes and must
not reinterpret current workspace plugin delivery. Characterization proves identical plugin
discovery/injection calls and bytes with SDD 427 lanes disabled and enabled across fresh/resume/fork;
cross-lane lifecycle tests prove plugin paths are untouched.

## Delivery slices

1. Shared `ProfileActivationHeadV2`, immutable content store/session selector, read barrier, legacy
   characterization and plugin non-interference, with no newly enabled lanes.
2. Soul + Persistent Instructions end to end, including migration, fresh/resume/fork and lane lifecycle hooks.
3. Evolution end to end with authoritative active inventory and session-pinned skills.
4. Human-approved selected memory end to end.
5. Cross-lane integration/dogfood; complete lifecycle orchestration remains consumed by `t-e50d4f`.

Every enabled slice includes its own authority, snapshot, migration, compatibility and tamper tests.
Runtime-managed memory is a separate later spec/task.

## Acceptance criteria

- [x] **Scenario: workspace bytes cannot activate themselves**
  - **Given** edited profile/lane bytes without the exact next host head
  - **When** fresh formation resolves
  - **Then** launch fails without fallback, partial lane omission or host signing of inferred authority
- [x] **Scenario: enabled lane failure cannot downgrade identity**
  - **Given** an authorized required Soul, instructions, Evolution or memory lane
  - **When** its identity, source, inventory, renderer or authority mismatches
  - **Then** the entire fresh launch fails rather than silently removing or mixing the lane
- [x] **Scenario: fresh formation is one consistent authority vector**
  - **Given** independently changing profile, Evolution and memory heads
  - **When** a fresh snapshot is built
  - **Then** all revisions are revalidated before atomic selector commit and no mixed/partial snapshot is selectable
- [x] **Scenario: selector publication survives every crash boundary**
  - **Given** durable objects, a prepared manifest and no committed selector
  - **When** publication crashes or retries before/during/after the authority-store transaction
  - **Then** recovery exposes exactly one committed selector+manifest or none, and GC never deletes an in-flight/reachable object
- [x] **Scenario: session ownership cannot be chosen or replayed by payload**
  - **Given** an authenticated launch/fork caller and bounded idempotency key
  - **When** it requests formation with forged owner/session/trust fields or reuses the key with different input
  - **Then** host-derived identity wins, conflicting replay fails, and exact replay returns only the original selector
- [x] **Scenario: resume and fork preserve exact payload bytes**
  - **Given** a selected immutable payload and later source mutation/deletion/rename
  - **When** restart, resume, rebind, re-anchor or same-snapshot fork runs
  - **Then** the exact retained prompt/skill payload is reused or the operation fails deterministically
- [x] **Scenario: operation boundaries prevent identity transfer**
  - **Given** an existing selector
  - **When** a caller changes principal, agent, runtime trust class or formation-affecting runtime policy
  - **Then** rebind/fork is refused and only a newly authorized fresh formation can proceed
- [x] **Scenario: Soul and instructions are bound to primary identity**
  - **Given** valid digest-bound sources whose subordinate metadata matches `agentId`
  - **When** a fresh profile session starts
  - **Then** exact bytes appear once in their existing ordered layers; name-only or stale bindings fail closed
- [x] **Scenario: Evolution exposes only the promoted active inventory**
  - **Given** a valid promotion head plus candidates/reviews/history/intents
  - **When** formation resolves
  - **Then** only enumerated active learning and skill artifacts enter the immutable payload
- [x] **Scenario: selected memory requires human promotion**
  - **Given** memory candidates, raw runtime history and one human-approved active inventory
  - **When** formation resolves
  - **Then** only bounded manifest-listed text is framed in the learned-memory layer
- [x] **Scenario: legacy and disabled agents remain compatible**
  - **Given** legacy agents or profile agents with lanes disabled
  - **When** they load/start/resume/fork
  - **Then** effective definitions, prompt bytes and plugin delivery remain unchanged
- [x] **Scenario: migration has one recoverable cutover point**
  - **Given** a legacy agent and prepared canonical sources/heads
  - **When** migration fails at any intent, pointer or host-commit boundary
  - **Then** launch remains blocked until recovery restores exact legacy state or completes exact canonical state, without fallback or dual authority
- [x] **Scenario: lifecycle ownership composes without duplicated orchestration**
  - **Given** lane-local prepare/retire/import operations from 427
  - **When** `t-e50d4f` orchestrates rename, clone or forget
  - **Then** one host intent owns ordering/recovery, authorities do not transfer, and plugin/external paths remain untouched
- [x] PI-001 passes with the same promise, oracle, guidance bytes and ordering.
- [x] Runtime-managed memory has a separate task/spec and no activation path in SDD 427.
- [x] Focused authority/snapshot/Soul/instructions/Evolution/memory/session/lifecycle/plugin tests, typecheck and configured full verification pass.

## Non-goals

- Runtime-managed memory or adapter autopromotion.
- Redesigning Soul or Evolution review UI/workflows.
- Activating candidates, reviews, histories, intents, transcripts, indexes or runtime databases.
- Treating task instructions, continuity or resume transcripts as persistent profile definition.
- Implementing agent-scoped plugins or changing workspace plugin behavior.
- Moving host authority, secrets or immutable snapshot payloads into the workspace profile.
- Cross-lane lifecycle orchestration or complete Agent Studio integration, owned by `t-e50d4f`.
- Non-plugin skill/MCP/hook materialization outside Evolution, owned by `t-a34bb7`.

## Open questions

None at the trust-contract level. Concrete serialization may change only if it preserves every
authority subject, revision, digest, transition and fail-closed rule above.
