# 423 — Canonical persistent agent profile

_Created 2026-07-22._

**Status:** shipped

**Closure:** Architecture-only contract ratified by the maintainer on 2026-07-22. This shipment fixes
the canonical ownership, trust, reference, snapshot and lifecycle requirements; it changes no runtime
behavior. Implementation remains in the dependency-ordered follow-ups under `t-7d2cc0`. Plugins remain
outside V1 and may be reconsidered only by their dedicated task chain.

## Intent

Tachyon currently persists the inputs that form an agent across several ownership and lifecycle
boundaries: the agent stanza in `tachyon.yml`, `.tachyon/agents/<agent>/SOUL.md`, the Agent Evolution
tree, runtime-private homes under `.tachyon/harness/<agent>`, runtime capability projections and
runtime-owned memory. A maintainer cannot inspect one bounded location and determine which
profile-governed durable inputs define a future fresh session. Runtime projections also mix executable
configuration with credentials, transcripts, logs, databases and caches, so treating a private runtime
home as the profile would collapse source, projection, ephemeral state and authority.

This specification defines `.tachyon/agents/<agent>/` as the discoverable root of one Tachyon agent's
canonical persistent profile. The root contains human-authored definition, selected learned state and
references to shared capabilities; it may contain clearly labelled governance and immutable snapshot
lanes. Runtime-native files remain generated projections. Credentials, host-custodied authorities,
session state and operational history remain outside the profile.

This slice specifies the contract only. Loading, YAML migration, runtime materialization and Agent
Studio lifecycle are delivered by follow-up Tasks under umbrella `t-7d2cc0`.

Affected Product Invariants: **none — this slice is architecture/documentation only and changes no
runtime behavior or registered oracle.** Every implementation slice must independently declare its
affected Product Invariants before changing code.

## Classification dimensions

Every persisted field/artifact is classified on two independent axes. This avoids calling a policy
“non-forming” merely because it is operational even when it changes a model, tool or environment.

**Effect axis:**

- **forming** — can change what a future session is, knows, can invoke or is persistently instructed
  to do;
- **governing** — constrains or authorizes execution without becoming ordinary model-owned content;
- **operational** — controls lifecycle, routing, isolation or verification without changing the logical
  model context/capability set;
- **history/ephemeral** — supports resume, audit, recovery or performance but does not define a future
  fresh session.

One field may be both forming and governing (for example model policy or an enforcement hook).

**Custody axis:**

| Custody class | Meaning | Typical owner | May be agent-writable? |
|---|---|---|---|
| Canonical definition | Human/product-owned intent that determines future sessions | Human/maintainer | Only through governed profile operations |
| Learned forming state | Selected durable memory or capability produced by an agent/runtime and intentionally reinjected | Agent/runtime, under an explicit promotion policy | Proposal/staging may be; active state follows its policy |
| Projection | Runtime-native bytes generated from canonical or selected state | Tachyon materializer | No canonical authority; direct mutation is untrusted divergence |
| Authority | Consent, freshness, integrity or enforcement state that decides which bytes are trusted | Host/human authority | No |
| Secret | Credential or sensitive value required to access a provider/tool | Secret owner/host store | No; profile stores references only |
| Ephemeral/history | Session, transcript, continuity, log, cache, queue, lock, recovery scratch or forensic artifact | Runtime/Tachyon | Not part of the profile contract |

Persistence alone does not make a datum agent-forming. The test is whether losing or changing it
changes what a future fresh session is, knows, can invoke or is persistently instructed to do.

## Canonical directory contract

The logical V1 shape is:

```text
.tachyon/agents/<agent>/
├── agent.yml                 # versioned manifest and human-owned definition/references
├── SOUL.md                   # optional stable identity; existing contract retained
├── instructions.md           # optional persistent operational specialization
├── evolution/                # existing Agent Evolution ownership retained
│   ├── profile.json          # active version selector and stable profile identity
│   ├── LEARNINGS.md          # approved active learned context
│   ├── skills/               # approved active evolved skills
│   ├── candidates/           # governance, never active prompt/tool input
│   ├── reviews/              # governance/audit
│   ├── history/              # governance/rollback provenance
│   └── ...                   # transaction/recovery protocol owned by Evolution
├── memory/                   # selected runtime-owned forming memory, when supported
│   ├── manifest.json         # version, provenance and active source inventory
│   └── active/               # only bytes selected for future reinjection
├── capabilities/
│   ├── skills.yml            # agent-local sources and shared capability references
│   ├── mcp.yml               # declarations/references; never literal secrets
│   └── hooks.yml             # requested hooks/references; trusted classifier decides authority lane
├── governance/               # optional pointers/status, not host authority bytes
└── snapshots/                # generated, immutable-by-contract launch/profile snapshots
```

The exact serialization may be refined by the implementation plan, but these semantic lanes are
normative. A different filename cannot merge their ownership or trust boundaries.

Structural invariants:

- canonical declaration and its desired selector may coexist in `agent.yml`, but no field in that
  agent-writable document constitutes external consent, promotion or freshness authority;
- learned content and its local selector/manifest may coexist in their lane, but activation always
  requires the external head defined by that lane's promotion policy;
- source bytes and generated runtime projection bytes never share a file/path identity;
- authority/secrets appear only as typed opaque references/status in the profile; authoritative bytes,
  keys, decisions and resolved values remain externally custodied;
- snapshots and governance/recovery artifacts are structurally labelled generated/adjacent lanes and
  cannot be discovered as active sources without a valid external selector/head;
- any serialization that cannot independently invalidate one lane without granting authority to
  another violates this contract.

### `agent.yml`

`agent.yml` is a versioned manifest, not an opaque copy of runtime config. It owns or references:

- schema version, immutable primary `agentId` and mutable display/path name;
- runtime selection and declared model/provider inputs;
- selected built-in role;
- activation/reference of `SOUL.md`, `instructions.md`, Evolution, memory and non-plugin capabilities;
- declared non-secret environment values and secret-reference identifiers;
- explicit inheritance policy for project/global inputs;
- persistent agent-specific operational policy that the contract elects to colocate;
- provenance requirements for shared or external references.

It does not embed transcripts, current Task instructions, Bridge tokens, provider credentials,
host-custodied keys, generated runtime files or plugin installation/scope declarations. Plugins remain
owned by the existing workspace plugin subsystem in V1.

### Canonical bytes versus references

- Agent-owned text/capability bytes live under this root when they have one-agent ownership.
- Project-wide guidance, built-in role templates, shared skills and other multi-agent sources
  remain at their owning scope. `agent.yml` or `capabilities/*.yml` records an explicit reference and
  assignment rather than copying them.
- Every reference declares its scope, owner, expected type and resolution mode (`pinned` or
  `floating`). `pinned` references carry immutable identity/version plus digest. `floating` references
  carry stable owner/source identity, resolve only at a fresh-launch snapshot boundary, and record the
  resolved digest in that snapshot. Executable skills, hooks and MCP launchers require
  a pinned digest or an external authority binding; guidance may float only when its owning project or
  product policy explicitly permits it.
- The resolver must constrain allowed roots, reject unsafe symlinks/special files, bind validated bytes
  to consumed bytes, and fail closed if either identity or digest changes during resolution.
- A reference writable by the governed agent is untrusted input. Its existence does not grant
  authority or consent.

### Reference matrix

| Reference class | Owner/scope | Modes allowed | Required binding | Resolution boundary | Mutation/failure result |
|---|---|---|---|---|---|
| `SOUL.md`, `instructions.md`, agent-local bundles | agent profile | pinned only when external to fixed conventional path; direct local file is bound by profile snapshot digest | `agentId`, type, relative path, digest | profile edit validation and fresh-launch snapshot | changed/missing bytes invalidate profile revision/lane; never use prior projection |
| Built-in role template | Tachyon distribution | pinned version only | role id, distribution version, template digest | profile resolution/fresh launch | unavailable/mismatched distribution refuses role materialization |
| Project Guidance | project | floating allowed by explicit project policy; pinned allowed | project source identity/path, policy mode; snapshot always records digest | fresh-launch snapshot only | unsafe/missing/racing source fails configured guidance; running snapshot stays pinned |
| Bridge guidance | Tachyon product + project enablement | pinned product version for each snapshot | guidance id, Tachyon version, enablement source, digest | fresh-launch snapshot | unresolved/mismatched bytes refuse guided launch path |
| Shared skill/resource | project/resource owner | executable bytes pinned; floating declaration may resolve only to a pinned launch digest under owner policy | owner/scope, resource id/version, payload digest, assignment authority where required | edit/consent plus fresh-launch snapshot | mutation after validation refuses materialization; no stale copy adoption |
| MCP server declaration | agent/project owner | declaration pinned by digest; executable/command target requires consent authority | server id, command/argv digest, env-reference names, scope, authority id | profile resolution + authority join | missing authority, changed command or literal secret refuses server |
| Hook | project/host authority | pinned only | hook id, event/function classification, executable digest, owner, enforcement authority where applicable | trusted classification/consent before snapshot | unknown/mutated/privileged hook refuses activation |
| Verification command/reference | project verification owner | pinned project config revision/digest | verifier id/argv, project config identity/digest | task/delegation verification boundary, not prompt launch | invalid/missing reference cannot produce proof and does not fall back silently |
| Worktree setup/resource path | profile/project owner | pinned command/config digest; workspace destination may be resolved operationally | setup id/argv digest, allowed root, project revision | managed worktree creation | changed/unsafe command refuses setup/launch |
| Secret reference | host secret owner | opaque typed reference only; never content-pinned in profile | secret namespace/id, expected consumer/purpose; identifier redaction policy | ephemeral injection after authority/snapshot validation | unresolved/unauthorized secret refuses dependent launch/capability without persistence |
| Runtime adapter/distribution | Tachyon product | pinned adapter/product version per snapshot | runtime id, adapter version/digest, capability contract | fresh launch | unavailable adapter version refuses launch rather than changing semantics |

## Field ownership matrix

| Concern | Canonical location/selector | Derived/adjacent state | Explicitly excluded |
|---|---|---|---|
| Runtime, declared model/provider | `agent.yml` | resolved launch projection and provenance | implicit cache as source of truth |
| Stable identity | `SOUL.md` + manifest activation/reference | Soul transaction recovery state | task/continuity prose |
| Persistent instructions | `instructions.md` + manifest activation/reference | runtime `AGENTS.md`/`CLAUDE.md` projection | current task brief |
| Built-in role | role id + product version/reference in `agent.yml` | template bytes from resolvable Tachyon distribution | duplicated mutable template copy |
| Project Guidance | shared project-owned source referenced by configured policy | startup brief materialization | copied agent-owned guidance |
| Bridge guidance | product-owned source + workspace enablement/reference | startup brief materialization | agent-editable protocol authority |
| Evolution active state | existing `evolution/profile.json`, `LEARNINGS.md`, `skills/` | session-pinned skill/prompt snapshots | pending candidates as active state |
| Evolution governance | `evolution/candidates`, `reviews`, `history` and recovery protocol | Agent Studio projections | prompt/tool activation without approval |
| Runtime-owned memory | `memory/manifest.json` and selected `active/` bytes | raw indexes/history at runtime scope | transcripts or DBs copied wholesale |
| Agent-local skills/MCP/hooks | `capabilities/*.yml` and agent-owned bundles/references | runtime-native skills/config/hooks | literal secrets or catalog presence as activation |
| Shared capabilities | explicit assignment/reference with scope and provenance | shared runtime projection | private copies that silently change scope |
| Workspace plugins | existing plugin subsystem outside the agent profile | workspace payload/lock/runtime projection | any per-agent declaration, migration or ownership in V1 |
| Consent/enforcement/freshness | opaque identity/status reference only | host-custodied authority record/head/key | authority bytes under agent-writable root |
| Operational lifecycle | declared per-agent policy in manifest or project config, as decided by resolver contract | worktrees, leases, sessions | those runtime instances as profile data |

## Current-surface disposition matrix

This table is normative for migration scope. “Authority” names the class that may legitimize the
value; it does not require that authority bytes live in the profile.

| Current surface | Effect / custody | Producer → consumer | Selector / authority | Canonical destination | Fail-closed result |
|---|---|---|---|---|---|
| `agents.<name>.cmd`, inferred `kind` | forming + operational / canonical | human/Studio → config loader, AgentManager | one profile runtime declaration; governed profile CAS | `agent.yml.runtime` | unsupported/conflicting runtime refuses launch |
| `cwd` | forming + operational / canonical | human/Studio → AgentManager | explicit profile value or explicit project default | `agent.yml.workspace.cwd` | unresolved/forbidden path refuses launch |
| `env` | forming/governing / canonical + secret refs | human/Studio + secret host → AgentManager/process | explicit value or allowlisted inheritance; typed secret refs resolved last | `agent.yml.environment` | literal secret/conflict/undeclared forming env refused |
| `autostart`, `watch`, `attention`, `restart` | operational / canonical | human/Studio → lifecycle/attention managers | profile value then explicit project default | `agent.yml.lifecycle` | invalid policy rejects profile; no prompt-layer effect |
| `instructions` | forming / canonical | human/Studio → prompt composer/runtime args | manifest activates exact file digest | `instructions.md` + reference | missing/divergent source omits/refuses lane per profile strictness; never use stale projection |
| `role` | forming / canonical + product reference | human → prompt composer | role id + resolvable product version | `agent.yml.role` | unavailable template version refuses role materialization |
| `soul` | forming / canonical + governed subprofile | human/Studio → Soul resolver/prompt | manifest activation + Soul profile binding/CAS | `SOUL.md` + bound metadata | id/digest mismatch blocks Soul lane |
| `selfEvolution` | forming/governing / canonical selector | human/Studio → Evolution coordinator/startup | profile enables; Evolution host head authorizes active version/digest | `agent.yml.evolution` + existing `evolution/` | missing/tampered head blocks Evolution activation |
| `worktree`, `branch`, `worktreeSetup` | operational; setup may be forming/governing / canonical | human → worktree/launch services | explicit profile policy; project defaults by named inheritance | `agent.yml.workspace` | invalid branch/setup policy refuses managed launch |
| `verify` | governing + operational / canonical reference | human/project → verification service | profile reference constrained by project verification authority | `agent.yml.verification` | invalid/missing verifier cannot be treated as proof |
| `harness.inherit` | forming/governing / canonical selector | human → HarnessManager | closed explicit mode; no ambient global inheritance | `agent.yml.capabilityInheritance` | undeclared source ignored; unsafe mode rejects profile |
| `harness.rules` / `instructions` | forming / canonical reference | human project files → HarnessManager → runtime prompt files | pinned/floating guidance rule plus launch digest | `capabilities/` reference or agent-owned source | path/digest race refuses materialization |
| `harness.skills`, Pi resources | forming/capability / desired declaration | human project files → HarnessManager → runtime | desired source + valid scope/policy; executable bytes pinned | `capabilities/skills.yml` and typed resource declarations | unsafe/unbound bytes refused |
| `harness.mcp` | forming/governing capability / desired declaration | human → HarnessManager/runtime | desired declaration ∩ consent/policy; secret refs resolved last | `capabilities/mcp.yml` | absent authority or literal secret refuses server |
| `harness.hooks` | forming/governing / desired declaration | human → HarnessManager/runtime | trusted classification + digest-bound authority | `capabilities/hooks.yml` request/reference | unknown/mutated/privileged hook refused |
| `isolate` | governing + operational / canonical | human → runtime-home/session manager | profile policy; host enforces | `agent.yml.isolation` | unsupported isolation refuses launch rather than sharing silently |
| `subagents` | governing + operational / canonical | human → ownership/display policy | profile relation constrained by workspace authority | `agent.yml.ownership` | cycles/conflicts reject relation |
| `settings.projectGuidance.files` | forming / shared canonical reference | project owner → prompt/startup composer | project setting owns bytes; profile records inherited dependency | remains project-wide; profile/snapshot records reference | unsafe/missing configured source fails project guidance contract |
| `settings.bridgeGuidance` and product bytes | forming/governing / shared product reference | project/product → prompt composer | project enablement + product version | remains project/product-owned; profile/snapshot records reference | unresolved version cannot silently use different bytes |
| Evolution `LEARNINGS.md`, `skills/`, active selector | forming / learned | approved proposal → startup snapshot | Evolution authority head binds agent id/version/digests | existing `evolution/` lane | mismatch blocks activation |
| Evolution candidates/reviews/history/intents | governing/history / governance | agent/human/Tachyon → Evolution workflow | never selected by directory discovery | existing `evolution/` governance lane | malformed/pending state never enters prompt/tools |
| runtime memory summaries/DB/transcripts | mixed learned + history | runtime → runtime memory loader | selected manifest/producer policy only | selected text to `memory/active`; raw stores remain runtime-owned | raw/unselected bytes never injected through profile contract |
| workspace plugin payload, lock and projection | external shared capability / existing plugin subsystem | installer → plugin engine/runtime | existing workspace plugin contract | remain in the current workspace plugin locations; no profile destination | profile migration must not move, rescope or narrow them |
| private runtime `config.toml`, `AGENTS.md`, skills/hooks/MCP files | forming at consumption / projection | Tachyon materializer → runtime | verified secret-free snapshot | remain generated runtime home | divergence never becomes canonical; refuse/rematerialize |
| runtime auth, sessions, history, DBs, logs, caches | secret or history/ephemeral | host/runtime → runtime | own lifecycle only | outside profile | never imported/exported as profile |
| startup/session snapshots | forming at replay / projection | resolver/materializer → launch/resume | external snapshot head binds agent/version/digest | labelled `snapshots/` lane | mutation/missing head blocks consumption |

### Closed runtime-native forming input inventory for V1

Adapters must map every forming/governing runtime input into one row below. A runtime-specific key not
classified by its versioned adapter manifest is denied; it cannot be inherited as an “operational”
escape hatch.

| Runtime-native input type | Examples/current path | Consumer | Canonical source or disposition |
|---|---|---|---|
| Runtime binary and argv | `agents.<name>.cmd`, generated CLI flags | shell/AgentManager/runtime CLI | profile runtime/model/provider + pinned adapter; raw legacy argv is compatibility input only |
| Model/provider/reasoning/service tier | command flags, Codex `config.toml`, provider env | runtime CLI | resolved profile fields; generated flags/config only; native override suppressed/refused |
| Prompt instruction files | private `AGENTS.md`, `CLAUDE.md`, project guidance files | runtime prompt loader | Soul/role/instructions/shared guidance snapshot; native files are projection |
| Skills and executable resources | private `skills/`, `.agents/skills`, `.claude/skills`, Pi resources | runtime capability discovery | desired profile/shared assignment ∩ authority, pinned payload digest |
| MCP servers | private/project runtime config, `.mcp.json`, Codex config blocks | runtime MCP loader | desired declaration ∩ consent/policy; ephemeral secret injection |
| Hooks | private/project hooks/settings | runtime hook executor | desired declaration + trusted classification + digest-bound authority |
| Plugins/apps/connectors | workspace plugin install/catalog/config | runtime/plugin host | external existing workspace plugin subsystem; no agent-profile selector in V1; agent-local scope is deferred to `t-f095b5` and `t-54cdb1`–`t-54cdb4` |
| Workspace/cwd/trust | cwd, project trust/native workspace config | runtime loader | profile workspace plus host trust authority; runtime trust cache is not canonical |
| Sandbox/approval/network/tool policy | runtime config/flags | runtime enforcement | host/project authority or explicitly allowed profile request; profile cannot weaken host policy |
| Non-secret environment | process env | binary/runtime/tools | profile values plus adapter-manifest operational allowlist; unknown inheritance denied |
| Secret/auth environment/files | `auth.json`, provider tokens, MCP env | runtime/provider/tool | host secret references injected ephemerally; persistent auth remains outside profile/export |
| Memory selected for reinjection | runtime memory summaries/index selection | runtime prompt/memory loader | closed runtime-memory policy and host activation head; raw DB/transcript excluded |
| Session/resume/fork identifier | session ledger, native session id | runtime resume adapter | host session-to-snapshot selector; not canonical agent definition |
| UI preferences, telemetry, caches, histories | runtime settings/cache/history/log DBs | runtime UI/observability | excluded unless adapter proves a specific key affects a forming/governing input above, then it must map explicitly |

### Environment channels

Environment inheritance is deny-by-default for profile resolution and forming inputs. Each versioned
runtime adapter publishes a closed operational allowlist needed to execute the process (for example
terminal/locale/temp mechanics) and an adapter-owned injection list. Those variables:

- cannot select or override runtime, model, provider, prompt, workspace, skills, MCP, hooks,
  memory or authority policy;
- are recorded by variable name/classification and adapter version, never sensitive value;
- fail launch if an unknown inherited variable is known to affect a forming/governing runtime input;
- resolve the binary/tool paths to recorded identities/digests where path selection could change code;
- remain separate from explicit profile environment and secret-reference channels.

## Trust and mutability rules

1. The profile is data, not approval authority. Direct workspace edits cannot mint human consent,
   Evolution approval or host freshness.
2. Secrets are never serialized into the profile, exports or snapshots. Only typed references may be
   present, resolved through the existing secret owner at launch.
3. Enforcement hooks and the authority that installs/validates them cannot be mutable through the
   ordinary agent profile. A read-only reference/status may be shown beside the profile.
4. Runtime projections are disposable as sources but security-sensitive as executed bytes. A
   materializer must define integrity, divergence and rematerialization behavior; a modified
   projection never silently becomes canonical.
5. Active learned state and proposed/governance state are distinct. Pending, rejected, historical or
   transaction bytes never become prompt/tool input by directory discovery.
6. Generated snapshots are labelled with source versions/digests and are immutable by contract for
   the session/version they represent. They record intended materialization, not proof that every byte
   reached a model.
7. Import/export includes canonical definition and explicitly selected learned state only. It excludes
   secrets, authorities, sessions, raw transcripts, caches, logs and host recovery state.

### Profile mutation authority

CAS proves freshness only. It never authorizes a mutation. Before preparing or committing any profile
edit intent, the host verifies an externally custodied authorization predicate binding:

- authenticated principal identity and kind;
- immutable `agentId`;
- exact permitted fields/lanes and operation kind;
- expected profile/authority revisions;
- resulting canonical digest; and
- expiry/single-use or durable delegation identity, as applicable.

Human/maintainer principals may authorize human definition, operational policy, inheritance and
desired capability declarations through the governed product surface. Product services may mutate
only their named recovery/metadata lanes. Agent/runtime principals cannot authorize changes to human
definition, Soul, role, instructions, runtime/model/provider, environment, inheritance, desired
capabilities, enforcement or lifecycle policy. Their only V1 forming-state mutation is through the
separate Evolution proposal/approval flow or an explicit runtime-memory delegation below. A caller
that can write workspace files or supply the expected CAS still cannot commit a host profile head.

## Identity and authority binding

`agent.yml` owns one immutable `agentId` (UUID) as the primary identity. The directory/name is a mutable
human-facing locator. Soul and Evolution retain their existing `profileId` values, but each active
subprofile is bound to `agentId`; neither subordinate id can stand in for the primary identity.
Authorities, approvals, snapshots and capability assignments bind to `agentId` plus their target kind,
version and content digest—not to the mutable agent name alone.

- Rename preserves `agentId` and subordinate bindings while changing the locator/name.
- Clone creates a new `agentId`; no authority or approval binding is inherited.
- Import creates a new `agentId` unless a governed restore proves exclusive ownership of the original
  identity and retires any competing instance.
- Forget retires authorities for `agentId` before the name can be reused; name reuse creates a new id.
- A mismatched or missing Soul/Evolution/memory binding blocks that lane from activation rather than
  attaching it by path coincidence.

## Declaration, selection, authority and projection

No profile file is simultaneously declaration and approval authority. The join is normative:

| Concern | Desired declaration/content | Selector | External authority | Active projection rule |
|---|---|---|---|---|
| Human definition, Soul, instructions | `agent.yml`, `SOUL.md`, `instructions.md` | manifest enables and references exact source | governed profile mutation/CAS; Soul keeps its profile transaction contract | snapshot includes only bytes matching the resolved identity/digest |
| Evolution learning/skills | Evolution active files | `evolution/profile.json.activeVersion` bound to `agentId` | existing host-custodied Evolution freshness/integrity head binds agent id, version and active content digest | any direct content/selector edit invalidates authority and blocks that lane/startup per Evolution contract |
| Runtime-owned text memory | `memory/active/**` | `memory/manifest.json` selects entries/digests and declared producer policy | a host-custodied delegation binds policy, principal/kind, scope/quotas and executable/renderer digests; a separate activation head references that delegation epoch and binds agent/version/manifest/content digests | arbitrary bytes or selector changes outside the selected producer/promotion path are ignored/refused; V1 memory is non-executable text only |
| Agent-local skill/MCP/hook request | `capabilities/*.yml` plus pinned bundles/references | desired assignment bound to `agentId` and digest | trusted policy/consent record approves exact target/digest; enforcement-hook classification is authority-owned | materialize only the intersection of desired declaration and valid authority; missing/expired/divergent authority is fail-closed |
| Workspace plugins (external in V1) | no declaration in the agent profile | existing workspace plugin subsystem | existing plugin installation/scope contract | the profile resolver does not install, select, migrate, clone, export or narrow plugins; current workspace availability remains unchanged |
| Project/product guidance | explicit shared reference and inheritance policy | fresh-launch resolver | owning project/product version and policy | resolve at fresh launch, record source identity/version/digest in secret-free snapshot |
| Enforcement hook | no ordinary active hook declaration is sufficient | trusted classification chooses hook target | host/project authority owns classification, digest and placement | unknown, mutated or privileged hooks are refused; agent-writable labels cannot downgrade enforcement |

### Plugin boundary (explicit deferral)

- V1 defines no `capabilities/plugins.yml`, plugin field, plugin assignment or plugin consent inside
  `.tachyon/agents/<agent>/`.
- A plugin installed at workspace scope remains available to all agents under the current workspace
  plugin contract. This SDD defines or changes no compatibility filter; the umbrella must not move the
  payload, change its scope or duplicate its lock.
- Isolated installation for one agent and any future workspace-versus-agent scope or profile
  integration are owned exclusively by `t-f095b5` and `t-54cdb1`–`t-54cdb4`; this SDD imposes no
  architecture or lifecycle requirements on that work.
- Until then, implementations under `t-7d2cc0` treat plugins as an external capability environment and
  prove non-interference with current workspace plugin behavior.

### Runtime-owned memory promotion policy

- `disabled`: no runtime-owned memory selector/content is consumed or updated.
- `runtime-managed`: the human-owned profile explicitly delegates **bounded persistent prompt-writing
  authority** to one named/versioned runtime memory adapter implementation for this `agentId`, bound
  to its immutable executable digest and deterministic renderer/prompt-layer contract digest. Free-form text cannot be
  mechanically proven to be a fact rather than an instruction; enabling this mode accepts that the
  adapter's selected text can influence and instruct future model behavior. The adapter may submit
  bounded text entries and revocations. The host validates shape, byte/entry quotas, producer identity,
  prior head and delegated scope, then atomically commits the new host-custodied activation head. The
  runtime cannot write or mint that head directly. This is explicit autopromotion under a high-trust
  human delegation, not human review of each entry.
- `human-approved`: the runtime adapter may submit proposals only; a human-authorized operation selects
  content and commits the activation head.

In both enabled modes, two host-custodied records have distinct responsibilities:

- the **delegation record** binds delegation id/epoch/status, policy, `agentId`, authenticated
  producer/approver principal identity and kind, exact allowed lane/operations, byte and entry quotas,
  adapter identity/version and executable digest (when applicable), and renderer contract digest;
- the **activation head** references the live delegation id/epoch and binds `agentId`, active memory
  version, a strictly monotonic activation revision, manifest digest and every active content digest.

A valid runtime-managed promotion under an unchanged live delegation atomically replaces only the
activation head after host validation and CAS against the host's current revision; it does not revoke
or rewrite the delegation. The host serializes activation-head replacement with delegation
status/epoch changes under one mutation boundary. Once an epoch is revoking/revoked, no promotion CAS
can commit. Prior signed heads remain auditable but are permanently ineligible for activation; the
host-custodied freshness revision rejects rollback/replay even when old bytes remain cryptographically
valid. Direct content or manifest edits outside that transition invalidate activation. The mechanically
enforced boundary is structural: runtime-managed memory may add only bounded text rendered in one
labelled learned-memory prompt layer. It cannot write executable files, structured tool declarations,
hooks, MCP, environment, role, Soul, human instruction files or capability assignments. It may still
express instruction-bearing natural language inside its delegated layer; the UI/export/provenance must
identify that risk and owner. Changing policy, principal identity/kind, delegated scope/operations,
byte or entry quotas, adapter identity/version, executable digest or renderer contract digest revokes
the delegation epoch and invalidates its activation head, leaving the lane inactive until a human
establishes a new delegation and initial head. Entry revocation within an unchanged delegation commits
a new activation head excluding the entry; a retired agent revokes the delegation and whole lane.

## Resolution and launch phases

The profile-governed launch definition is assembled in this order:

1. **Resolve canonical definition:** read one profile schema/identity and legacy compatibility input;
   resolve explicit shared references without secrets.
2. **Join selectors and authority:** verify profile CAS, Evolution heads, capability consent,
   hook classification and learned-state producer/promotion bindings.
3. **Create secret-free snapshot:** freeze effective text, profile-governed non-plugin capability
   identities, source versions and digests. Snapshot bytes are a generated projection in a structurally
   labelled `snapshots/` lane; their integrity head is externally custodied. A change to a source or
   authority bound by this profile contract invalidates them; plugin-subsystem mutation is outside this
   snapshot and its lifecycle.
4. **Materialize runtime projection:** generate runtime-native config, skills, hooks and MCP launch
   descriptors from the verified snapshot. Divergence is refused or overwritten according to the
   materializer contract, never adopted.
5. **Inject secrets ephemerally:** resolve typed secret references into process environment or another
   non-persisted runtime channel only after snapshot/authority validation. Resolved values never enter
   profile, snapshot, projection, diagnostics or logs; secret identifiers are redacted where their
   names reveal sensitive relationships.
6. **Launch and record provenance:** record profile snapshot/authority identities and digests, not
   secret values or external plugin state.

## Canonical precedence by field family

The profile contract chooses the semantic precedence now; follow-up `t-17a2c2` implements it:

| Field family | Effective precedence |
|---|---|
| Profile existence | one `tachyon.yml` entry points to one profile; a legacy inline stanza is an alternative compatibility source, never a simultaneous owner |
| Runtime/model/provider | explicit profile declaration; then explicitly allowlisted profile inheritance; no ambient/private config override. Generated command flags implement the resolved value |
| Non-secret environment | explicit profile value; then explicit named inheritance allowlist. Undeclared ambient values cannot become forming provenance |
| Secrets | typed profile reference resolved by host at launch; no literal value or fallback copied from YAML/runtime home |
| Soul/instructions/role | profile activation/reference; built-in role bytes bind to a resolvable Tachyon distribution version |
| Project/Bridge guidance | project/product owner and explicit enablement; agent profile may reference/opt into allowed policy but cannot replace owner bytes |
| Learned memory/Evolution | only selected content with valid producer/promotion authority and matching digest/version |
| Skills/MCP/hooks | desired declaration intersected with valid consent/policy authority; authority constraints always win over desired capability |
| Plugins | outside the V1 profile resolver; existing workspace plugin semantics remain unchanged |
| Operational fields | all agent-specific lifecycle/routing/isolation/verification fields live in `agent.yml`; project-wide defaults remain in `tachyon.yml` and apply only through explicit profile inheritance |

Raw runtime `config.toml`, hooks files and private-home bytes are projections. If they can override the
resolved profile at runtime, the adapter must suppress, isolate or reject that launch; their precedence
cannot silently outrank this contract.

## Precedence and provenance contract for follow-up resolution

Follow-up `t-17a2c2` must implement the precedence above with a field-level resolver providing:

- one effective value and source classification per field;
- explicit inheritance rather than ambient adoption;
- provenance identifying canonical source, shared reference or external product dependency;
- fail-closed errors for conflicting canonical owners or unsafe references;
- diagnostics for runtime-native values that can override the declared profile;
- a stable compatibility rule for legacy `tachyon.yml` stanzas;
- no secret values in diagnostics, profile state or provenance artifacts.

Until that resolver is delivered, `agent.yml` is the target contract, not current runtime behavior.

## Lifecycle contract

Every cross-store operation uses a durable host-owned intent and one launch-visible state:
`preparing → committed` or `preparing → recovering → committed|rolled-back`. While an intent is not
terminal, launch/clone/export for the affected identity fails closed. Operations are idempotent by
intent id. The commit point is the externally custodied identity/authority head; workspace paths alone
cannot declare completion.

| Operation | Preconditions | Commit point | Recovery / resulting lane behavior |
|---|---|---|---|
| Create | name free; new immutable `agentId`; schema valid | authority/profile head establishes the exact initial digest | partial roots are quarantined or completed idempotently; no launch before head exists |
| Edit | valid host-custodied mutation authorization for principal/agentId/field lanes/result digest; expected profile revision/CAS; referenced authority still current | new profile head binds authorization identity and resulting canonical digest | projections/snapshots are invalidated and rebuilt; failed edit returns old complete profile; CAS alone authorizes nothing |
| Rename | target name free; source identity/head current | authority mapping moves same `agentId` to new locator and retires old locator | source/target staging is reconciled; neither path launches while ambiguous |
| Clone | source snapshot valid; target name free | new profile head for a new `agentId` | human definition and explicitly exportable content copy; all authority/approval bindings are absent and capabilities/learned lanes stay inactive until reauthorized |
| Forget | current identity known; no competing lifecycle intent | authority for `agentId` and name locator is retired before workspace deletion is final | retry retirement/deletion idempotently; name reuse blocked until retirement is confirmed |
| Export | profile stable and no lifecycle intent; caller authorized | immutable export manifest/digest is written | includes secret-free human definition, content/provenance and explicit learned bytes; excludes active authority and marks every authority-gated lane `requiresReauthorization` |
| Import | bundle valid; target name free | new `agentId` profile head (or separately governed exclusive restore) | references are revalidated; learned/capability content may import but remains inactive until local authority is issued |
| Snapshot | complete effective resolution and all authority joins valid | external snapshot head binds agent id, source versions and digest | mutated/missing snapshot is never consumed; rematerialize for fresh launch or use the session-pinned valid snapshot for resume/fork |

### Edit authority transition

The same host-owned edit intent computes transitions for every lane before committing the new profile
head:

| Edit result for a lane | Existing binding | Required transition |
|---|---|---|
| target, identity, selector and digest unchanged | current and valid | preserve binding; record it in resulting profile head |
| human definition bytes changed | profile CAS/head | commit new canonical digest; invalidate snapshots/projections |
| Evolution active bytes/selector changed outside approved promotion | Evolution head no longer matches | reject edit as unauthorized; no partial profile commit |
| runtime-memory content changed through selected producer policy | valid prior memory head | producer/promotion creates next memory head inside the intent; otherwise lane becomes inactive |
| memory policy/producer changed | old memory head | revoke old delegation/head; lane inactive until a new head is established |
| capability desired target or digest changed | old consent bound to prior target | revoke/detach old binding; desired declaration may commit but lane is inactive until exact new consent exists |
| shared reference version/digest changed | prior snapshot/reference binding | revalidate owner/policy; invalidate snapshots; authority-gated lane inactive until matching binding exists |
| secret reference changed | prior secret authorization | no secret value copied; dependent lane/launch requires new host authorization at next launch |
| hook classification/executable changed | prior hook authority | revoke old binding; unknown/new hook inactive until trusted classification/authority |

The profile edit may commit with an explicitly inactive optional lane, but cannot claim that lane active.
If the profile marks the lane `required`, missing reauthorization blocks commit/launch. While cross-store
heads are being prepared or reconciled, launch is blocked for the affected `agentId`.

### Session snapshot selector and revocation

The host custodies a selector mapping `sessionId` (and each authorized `forkId`) to `agentId`,
`snapshotId`, snapshot digest and source authority revisions. A workspace ledger may mirror this data
but is not the selector authority.

- Fresh launch verifies every source/consent/learned authority, creates the snapshot and commits the
  session selector before runtime delivery.
- Resume/rebind uses the exact selected snapshot and rechecks snapshot integrity, agent lifecycle
  non-retirement and all **revocable execution authorities** owned by this profile contract: secrets,
  MCP/tool consent, network, sandbox and enforcement hooks. Revocation fails closed; the session is not
  silently degraded.
- Content authorities frozen into the snapshot (Soul/instructions/approved learned text and skill
  bytes) remain session-pinned and are not replaced by newer active versions on resume. Retirement or
  explicit security revocation of the agent/snapshot still blocks use.
- Fork requires a host-authorized new `forkId` bound to the same valid snapshot or a deliberate fresh
  resolution; path/session metadata cannot select an arbitrary snapshot.
- A structurally intact snapshot with expired/revoked required execution authority is not valid for
  launch. The human may authorize a fresh snapshot/session after resolving the authority change.

### Resume/fork execution-authority matrix

Byte pinning and permission to execute are separate. Resume/fork always uses the pinned bytes, but
revalidates every applicable execution authority below:

| Snapshot class | Bytes/version pinned? | Authority revalidated on each process launch/resume/fork | Revoked/expired result |
|---|---|---|---|
| Soul, role, human instructions, guidance, learned text | yes | snapshot integrity and agent/snapshot non-retirement; no substitution with newer content | fail closed on integrity/retirement; otherwise preserve session content |
| Evolved or agent-local skill bundle | yes | skill execution/availability policy and any capability consent bound to target digest | fail closed for required catalog; no execution/read exposure after revocation |
| MCP server/command | yes | MCP consent, command digest, network/tool policy and current secret authorization | fail closed before process/server launch |
| Hook executable | yes | trusted classification, hook/enforcement authority, event/scope and executable digest | fail closed; mutated/revoked hook never executes |
| Pi extension/package or other executable resource | yes | resource execution policy, source/payload digest and relevant consent | fail closed before resource discovery/execution |
| Runtime adapter/binary | yes | supported adapter/product authority, binary/adapter digest and host policy | fail closed; no fallback to a different adapter/version |
| Sandbox/network/tool policy | policy identity/version pinned | current host/project enforcement authority; profile cannot weaken it | fail closed when required policy cannot be applied |
| Secret reference | identifier/purpose pinned, value never snapshotted | current secret access authorization and purpose/consumer binding | fail closed for dependent capability/launch; no cached-value fallback |

Optional capability removal is not silently applied to an existing session because that changes the
session's effective agent. The resume/fork operation fails with an actionable authority error; a human
may start a fresh session from a newly resolved profile without the capability.

### Clone/export lane policy

| Lane | Clone | Export/import |
|---|---|---|
| Human definition, Soul, instructions | copied with provenance into new identity | included; import binds to new identity |
| Shared references | retained as references and revalidated | included as references; never silently vendored |
| Evolution/memory active content | copied only when explicitly selected; provenance retained | bytes may be included by explicit export policy |
| Evolution/memory active selector | reset inactive for clone | imported inactive |
| Evolution/capability approvals and authority heads | never copied | never exported/imported |
| Agent-local capability bundles | content may copy; desired assignment may copy | content/declaration may export; inactive until local consent/authority |
| Snapshots | never copied as active session state | excluded except a separately requested forensic export |
| Secrets, sessions, transcripts, continuity, logs, caches | never copied | never exported/imported |

## Acceptance criteria

- [x] The spec defines canonical definition, learned forming state, projection, authority/secret,
  operational policy and ephemeral/history as separate classes.
- [x] The normative directory tree assigns identity, instructions, Evolution active/governance state,
  selected memory, non-plugin capabilities, governance references and snapshots to explicit lanes.
- [x] **Scenario: inspecting one agent root**
  - **Given** a maintainer inspects `.tachyon/agents/<agent>/`
  - **When** they follow the manifest and declared references
  - **Then** they can identify every profile-governed canonical input and declared dependency intended
    to form a future fresh session without treating runtime-home contents as source of truth; external
    environments not declared by the profile, especially workspace plugins, are outside this completeness
- [x] **Scenario: an executable projection diverges**
  - **Given** runtime-native config, skill, MCP or hook bytes differ from their declared source
  - **When** the future resolver/materializer evaluates the agent
  - **Then** the projection cannot silently become canonical and the contract requires detectable
    divergence plus an explicit rematerialize/refuse policy
- [x] **Scenario: authority remains outside the governed profile**
  - **Given** an agent or workspace process can modify `.tachyon/agents/<agent>/`
  - **When** it changes profile, governance pointer or capability reference bytes directly
  - **Then** it cannot mint human consent, host freshness, Evolution approval, enforcement authority
    or a secret
- [x] **Scenario: shared non-plugin capability remains shared**
  - **Given** a project/runtime capability is assigned to multiple agents
  - **When** one agent profile references it
  - **Then** the reference records assignment/provenance without copying bytes or changing the
    capability's ownership and blast radius
- [x] **Scenario: selected memory is separated from runtime history**
  - **Given** a runtime home contains memory summaries, indexes, databases and transcripts
  - **When** persistent forming memory is represented in the profile
  - **Then** only explicitly selected/reinjected bytes and provenance are included; raw history remains
    outside the canonical profile
- [x] The ownership matrix classifies current Soul, Evolution, harness, guidance, memory and
  runtime configuration surfaces without classifying whole directories merely by persistence.
- [x] A field-by-field matrix identifies effect class, custody class, producer, consumer, selector,
  authority, canonical destination/reference and fail-closed result for every current agent stanza and
  forming runtime-home surface.
- [x] A reference matrix specifies pinned/floating mode, required identity/version/digest, resolution
  boundary and mutation result for every reference class.
- [x] The declaration/selection/authority/projection table closes learned-state promotion, guidance and
  hook enforcement semantics.
- [x] The plugin boundary defines no profile plugin field or `plugins.yml`, preserves current
  workspace-wide availability, and defers agent-scoped installation to `t-f095b5` and
  `t-54cdb1`–`t-54cdb4`.
- [x] One immutable primary `agentId` binds subordinate Soul/Evolution/memory identities, authorities,
  snapshots and lifecycle operations.
- [x] The launch-phase contract separates secret-free resolution/snapshot/materialization from
  ephemeral secret injection and persisted provenance.
- [x] Lifecycle rules cover create, edit, rename, clone, forget, import/export and snapshot boundaries.
- [x] Each lifecycle operation declares preconditions, external commit point, incomplete-state launch
  behavior, idempotent recovery and per-lane clone/export handling.
- [x] The follow-up resolver contract requires field-level precedence, provenance and diagnostics
  before implementation claims `agent.yml` as effective runtime authority.
- [x] Secrets, host authority, transcripts, continuity, logs, caches, databases, locks, queues and
  temporary/recovery scratch are explicitly excluded from ordinary profile export and canonical input.
- [x] The spec is independently reviewed against the repository inventory before being ratified.

## Non-goals

- Implementing the profile loader, schema parser, migration, projection materializer or Agent Studio.
- Moving or rewriting existing Soul or Agent Evolution data in this slice.
- Selecting one serialization library or internal TypeScript module layout before implementation.
- Centralizing runtime homes, transcripts, continuity, logs, caches, databases or forensic history.
- Storing credentials, tokens, provider secrets, authority keys or freshness heads in the agent root.
- Making workspace-wide skills, MCP or guidance private to one agent by copying them.
- Integrating, migrating or redesigning plugin installation, lockfiles, consent or
  workspace-versus-agent scope. That work belongs to `t-f095b5` and `t-54cdb1`–`t-54cdb4`.
- Redesigning Soul, Agent Evolution or runtime-native memory workflows beyond the interfaces needed by
  the canonical profile contract.
- Claiming that a written startup snapshot proves delivery to the model.
- Removing legacy `tachyon.yml` compatibility before migration and installed rollout evidence.

## Open questions

No trust-boundary question remains open for ratification. Follow-ups may choose implementation
mechanics only within these constraints:

- the concrete host-custodied record implementing non-plugin capability consent;
- runtime adapter mechanics for producing bounded non-executable selected memory under the declared
  `disabled | runtime-managed | human-approved` policy;
- snapshot retention duration and quota, provided integrity, privacy and session pinning remain true;
- serialization/module APIs, provided source, selector, authority and projection semantics cannot be
  merged into one agent-writable authority.
