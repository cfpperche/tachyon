# 437 — agent-profile-bundle — plan

_Drafted from `spec.md` on 2026-07-22. The approach, not the steps (those go in `tasks.md`)._

## Approach

Create `agentProfileBundle.ts` with a closed Zod schema independent of `AgentProfileV1`. The document contains only portable runtime preferences, display name, role, optional embedded Soul/instructions, and bounded `requiresReauthorization` descriptors. Export is field-by-field positive projection; canonical JSON recursively sorts object keys and hashes exact UTF-8 bytes.

Import accepts canonical bytes plus a destination name. It rejects noncanonical encodings and unknown fields/versions, then converts the portable definition into a lifecycle `create` request with `enabled:false`, a fresh identity minted only inside the lifecycle transaction, no prior authority/grants, and fixed profile-local document paths. Extend lifecycle create with a narrow `createArtifacts` seam so document bytes are staged, fsynced, published and compensated with the profile tuple; edits cannot use it.

Clone literally calls export then import; there is no stored-profile shortcut. A file-reader helper accepts only a bounded regular no-follow file, while the core parser remains byte-based for Studio/Bridge callers.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Single JSON document** — avoids archive traversal, links, duplicate paths and decompression limits.
- **Positive portable schema** — prevents future stored/derived fields from becoming exportable by accident; heuristic redaction is rejected.
- **No environment values in V1** — a generic env value may contain a credential and there is no explicit exportability marker today.
- **Soul/instructions only as embedded content** — these are the two bounded profile-local authored documents needed to preserve formation; all other references become inert requirements or are omitted.
- **Always disabled on import/clone** — destination-local enable and authority decisions must happen after inspection; installed capabilities are never resolved automatically.
- **Reuse lifecycle create transaction** — preserves its lock, CAS, authority and recovery contract; a second general journal would duplicate machinery.
- **Exactly V1** — no migration registry until another version exists.

## Files touched

- `src/config/agentProfileBundle.ts` — portable schema, canonical encoding, export/import conversion and bounded file read.
- `src/config/agentProfileLifecycle.ts` — narrow staged artifact support for create.
- `src/workspace/Workspace.ts` — host-custodied export/import/clone entry points.
- `test/unit/agentProfileBundle.test.ts` — deterministic projection, hostile inputs, fresh identity, reauthorization and clone equivalence.
- Lifecycle/Workspace tests — crash compensation and compatibility.

## Risks & unknowns

- Lifecycle compensation must remove only exact imported artifact bytes and leave a degraded journal on custody mismatch.
- Canonical JSON validation must reject alternate but semantically equivalent input so digest/CAS behavior is unambiguous.
- User-authored Soul/instructions may contain sensitive prose; documentation must not claim semantic secret scanning.

## Visual impact

None; UI is the dependent `t-149877` slice.

## Sources consulted

- SDDs 429, 430 and 431; canonical profile schema, reader and lifecycle transaction.
- Architecture review `probe-d43d3e34-0d1a-4787-bd0a-fe7984307266` (full result under `.tachyon/probes/`).
