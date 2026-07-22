# 423 — Canonical persistent agent profile — plan

_Drafted from `spec.md` on 2026-07-22. Architecture-only slice; no product code is in scope._

## Approach

Turn the existing inventory into one ratifiable contract before any loader or migration exists. The
contract starts from effects and trust boundaries rather than current directories: identify which
bytes affect a future fresh session, classify their owner and authority, then assign canonical lanes
or external references under `.tachyon/agents/<agent>/`.

The work has four reviewable passes:

1. **Current-state evidence.** Cross-check every row in the field ownership matrix against existing
   config, prompt composition, Soul, Evolution, harness, plugin and runtime-home code. Record producer,
   consumer, scope and whether bytes are canonical, selected, projected or merely persisted.
2. **Normative contract.** Ratify the directory tree, manifest responsibilities, reference/path rules,
   active-versus-governance boundary and authority/secret exclusions. This pass decides semantics, not
   TypeScript APIs.
3. **Lifecycle and follow-up seams.** Confirm create/edit/rename/clone/forget/export/snapshot behavior
   and turn unresolved runtime precedence and memory selection into explicit contracts owned by
   existing follow-up Tasks; record plugins as a deliberately external subsystem.
4. **Independent review.** Ask a read-only Codex probe to attack false canonical claims, hidden
   authorities, unsafe path/reference assumptions and source/projection ambiguity. Fold valid findings
   into the spec, run documentation/mechanical verification, then request maintainer ratification.

The SDD itself is the architecture decision artifact. A separate ADR would duplicate ownership unless
review identifies a project-wide decision that must survive independently of this specification.

## Key decisions

- **Use `.tachyon/agents/<agent>/` as a discoverability and canonical ownership root** — Soul and
  Evolution already establish this namespace; rejected `.tachyon/harness/<agent>` because it is a
  runtime-specific projection mixing config, auth, sessions, memory databases, logs and caches.
- **Classify by effect and authority, not persistence or container** — fields within one YAML stanza or
  directory have different semantics; rejected moving whole stanzas/homes because that would preserve
  current ambiguity inside a new location.
- **Keep four protected semantic lanes** — canonical definition, learned/runtime-owned forming state,
  projections and authority/secrets; rejected one flat writable profile because the governed agent
  could otherwise alter consent, enforcement or effective executable bytes.
- **Represent shared capabilities and guidance by assignment/reference** — ownership and blast radius
  remain project/runtime-wide; rejected per-agent copies because copies silently fork shared truth.
- **Treat runtime projections as derived but security-sensitive** — they are not canonical, yet runtimes
  execute them directly; rejected calling them disposable caches without integrity/divergence rules.
- **Keep selected memory distinct from raw runtime history** — reinjected bytes form future behavior,
  while transcripts/indexes/databases are provenance or implementation; rejected copying the runtime
  memory directory wholesale.
- **Preserve existing Soul and Evolution subcontracts** — the profile root coordinates them without
  rewriting their approved ownership, promotion or authority model; rejected a new monolithic JSON
  document that would erase independent lifecycle and human review boundaries.
- **Defer exact precedence to the resolver follow-up while making it a required contract** — current
  mechanics remain runtime-specific, but SDD 423 now fixes semantic precedence and fail-closed outcomes;
  rejected deferring source/selector/authority choices because those define the trust boundary.
- **Bind all authority to one immutable `agentId`, target, version and digest** — mutable names and
  subordinate Soul/Evolution ids cannot carry approval alone; rejected path/name identity because
  rename, clone and reuse would inherit stale authority.
- **Keep plugins outside the V1 profile contract** — existing workspace plugins remain shared and
  agent-scoped installation stays with `t-f095b5` and `t-54cdb1`–`t-54cdb4`; rejected adding
  `plugins.yml` because it would pre-empt decisions owned by that dedicated task chain.
- **Separate secret-free snapshot/materialization from ephemeral secret injection** — persistent
  profile/provenance stays exportable without credentials; rejected resolving secrets before snapshot
  because values could leak into projections, logs or diagnostics.
- **Use host-owned lifecycle intents with an external commit point** — multi-store rename/clone/forget
  cannot be declared complete by workspace paths; rejected best-effort cleanup without launch blocking.
- **Keep the umbrella decomposed** — loader, YAML migration, state, capabilities, Studio lifecycle and
  rollout are independently shippable and have explicit Tasks; rejected implementing from one broad SDD.

## Files touched

| Path | Purpose |
|---|---|
| `docs/specs/423-agent-profile-contract/spec.md` | Normative directory, ownership, trust, lifecycle and acceptance contract |
| `docs/specs/423-agent-profile-contract/plan.md` | Evidence/review approach and decisions/rejections |
| `docs/specs/423-agent-profile-contract/tasks.md` | Ordered architecture verification and ratification checklist |
| `docs/specs/423-agent-profile-contract/notes.md` | Probe findings, maintainer decisions and verification evidence |

No `src/`, schema, test or UI file changes in this slice.

## Risks & unknowns

- Current runtime/model/provider precedence may contradict a naive `agent.yml` source-of-truth claim;
  the spec therefore names a target contract and requires the resolver to prove effective precedence.
- Plugin scope has a separate active task chain. The risk here is accidental overlap: this umbrella
  must not introduce a second plugin source of truth or change current workspace-wide availability.
- Runtime-owned Codex memory mixes selected forming state with provenance, indexes and storage internals;
  the contract limits selected runtime-managed memory to bounded non-executable text with an explicit
  producer/promotion policy; adapter mechanics still need proof before migration.
- A generated projection can be tampered with and execute before rematerialization. Follow-up design
  must define write permissions, integrity and divergence handling.
- Shared references can traverse unsafe roots, symlinks or agent-writable files. Path custody must bind
  validation and consumption rather than trusting a string path.
- Product-owned role/Bridge guidance bytes can change with extension upgrades. Version/reference
  provenance needs a resolvable distribution, not merely a version label.
- Snapshot reproducibility can conflict with transcript/privacy retention. Retention remains a separate
  explicit policy decision.
- Moving operational fields into a per-agent profile can make project-wide governance less visible.
  The resolver slice must decide field placement without treating colocation as identity.
- Runtime-managed memory is deliberate bounded self-modification. The host activation head and
  non-executable closed schema must prevent that delegation from becoming arbitrary prompt/tool/config
  mutation.
- Existing workspace-wide plugin semantics remain untouched and external to the profile. Agent-local
  plugin installation and any later profile integration are deferred to the dedicated plugin Tasks.

## Visual impact

**Visual QA Opt-Out:** this slice changes tracked architecture documents only and introduces no
rendered product surface. Agent Studio visual behavior belongs to `t-e50d4f`.

## Sources consulted

- `.tachyon/reports/agent-persistent-formation-inventory-2026-07-21.md` — current-state inventory and
  incorporated Codex adversarial review.
- `src/config/loadConfig.ts` and `src/config/tachyon.schema.json` — `ManagedEntryDef`, harness,
  instructions, role, Soul, Evolution and project settings.
- `src/agents/promptLayers.ts`, `src/agents/startupBrief.ts` and
  `docs/architecture/startup-briefs.md` — effective prompt layers and launch materialization boundary.
- `src/agents/soul.ts` and `src/agents/soulProfileTransactions.ts` — canonical Soul path and lifecycle.
- `src/evolution/EvolutionStore.ts`, `src/evolution/startupSnapshot.ts` and SDD 421 — active state,
  governance, host authority and session-pinned projection semantics.
- `src/harness/HarnessManager.ts` and `src/agents/AgentManager.ts` — private runtime homes, inherited
  config, generated resources and launch consumption.
- `src/plugins/engine.ts` — evidence for preserving the existing external workspace plugin boundary.
- Actual workspace trees under `.tachyon/agents/codex`, `.tachyon/harness/codex`, `.codex`, `.claude`
  and `.agents` — evidence that canonical, projection, runtime and ephemeral bytes are currently mixed.
