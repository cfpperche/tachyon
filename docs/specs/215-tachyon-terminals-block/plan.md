# 215 — tachyon-terminals-block — plan

## Architecture

A config-surface change. The single source of truth downstream stays `config.agents`
(kind-tagged); `terminals:` is parsed and **merged in**. The Studio learns to target the right
block. No engine code changes.

```
config/loadConfig.ts
  - parseConfig: after agents, parse a top-level `terminals:` mapping. Each entry reuses the
    SAME per-field validation as an agent entry, but: kind is forced to "terminal"; an explicit
    `kind` key is an error; `instructions` is an error. Merge results into the `agents` record.
    Reject a name present in BOTH agents: and terminals:. Add "terminals" to the allowed
    top-level keys.
  - Factor the per-agent field parsing into a reusable helper so agents: and terminals: share it
    (no copy-paste drift). Returns {def, errors} for one entry.
config/tachyon.schema.json
  - add a `terminals:` object mirroring the agent entry, minus `kind`/`instructions`.
config/YamlConfigEditor.ts
  - sectionOf(doc, name): which block ("agents"|"terminals") currently holds `name` (for edits).
  - upsertAgent gains a target section: new entries go to the section implied by kind
    (agent→agents, terminal→terminals); edits rewrite in the entry's existing section; rename +
    layout-ref updates work against that section. Keep the existing signature working (default
    agents) so other callers (promote/clone/schedule) are untouched.
  - deleteAgent / renameAgent / agentEntryLine: resolve across both blocks.
workspace/Workspace.ts
  - studioSubmit: for kind==="terminal", route to the terminals-aware upsert; agent path unchanged.
init/initLogic.ts
  - buildStarterYaml: emit stack terminals under a `terminals:` block instead of `agents:` +
    `kind: terminal`; keep the AI agent under `agents:`. Update the teaching comments.
README.md — the "kind taxonomy" section gains the `terminals:` block as the recommended form.
```

## Sequencing

1. Parse: refactor per-entry agent parsing into a shared helper; add `terminals:` parsing + merge
   + collision + kind/instructions rejection; schema. Tests (round-trip, collision, rejections,
   backward compat). **Pure — no engine change.**
2. YamlConfigEditor: `sectionOf` + section-aware upsert/delete/rename/entryLine across both
   blocks. Unit tests (create-new-terminal → terminals:; edit-legacy-terminal → stays in agents:;
   edit-terminals-entry → terminals:; rename; collision).
3. Workspace.studioSubmit routes terminal writes; verify the create/edit/rename flows.
4. Init: `terminals:` block in the starter yml; round-trip test.
5. Docs (README + starter comment). codex dueto + ship.

## Risks / edges

- **Edit-in-place must not move a legacy terminal** — sectionOf resolves the current block; the
  upsert writes there. A create with no prior entry uses the kind-implied section.
- **Layout refs** point at names, not sections — rename updates them regardless of block.
- **Collision** (same name in both blocks) is rejected at parse AND the editor refuses to create a
  name that exists in either block.
- **`stringify` of a brand-new `terminals:` block** must preserve existing comments elsewhere —
  the yaml Document API already guarantees this (same path as every other upsert).
- Keep `addAgent`/`cloneAgent`/promote on `agents:` (they're AI-agent or generic paths); only the
  Studio Terminal tab is terminal-section-aware in v1.
