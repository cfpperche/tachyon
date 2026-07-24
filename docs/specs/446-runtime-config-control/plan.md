# 446 — runtime-config-control — plan

_Drafted from `spec.md` on 2026-07-24. The approach, not the steps (those go in `tasks.md`)._

## Approach

Build a small runtime-configuration adapter boundary rather than binding Control directly to home
files. Each adapter returns a content-free inventory plus only the measured editable settings and
tooling entries for a `global` or `workspace` source. An adapter owns parse, atomic patch and
preservation rules for its native file shape.

Ship in slices:

1. Replace the static prototype with the Control route, typed host messages and a read-only Codex
   source adapter. It must distinguish global/workspace and show real source paths/inventory. This
   is independently shippable and does not mutate native files.
2. Extend the canonical SDD 442 adapter with Codex's measured scalar editor and individual MCP
   entries. Its writer must compare a captured source revision before atomic write, preserve the
   unowned data contract, and make Global's external effect explicit; no second Control-owned source
   of truth is allowed.
3. Add lifecycle freshness wiring so Start/Restart/Resume resolves the changed source and clears a
   pending marker only after successful materialization. Resume must recompute the effective
   composition and surface its delta rather than silently assuming it equals Start.
4. Add each additional runtime only after measuring its format and lifecycle boundary; update the
   parity matrix rather than assuming Codex mechanics generalize.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Adapter-owned native formats** — each runtime reads and writes its own measured shape; rejected
  a generic JSON/TOML editor because it would either corrupt unknown config or recreate an endless
  schema mirror.
- **Individual tooling entries** — toggles operate on a named skill/MCP/hook/extension, never a
  whole category; rejected category toggles because their actual file effect is ambiguous.
- **Source scope first** — Global and Workspace are separate views and separate source files;
  rejected an implicit merged editor because a human must know exactly which file changes.
- **Restart boundary by default** — save marks impacted running agents pending and leaves them live;
  rejected automatic restarts and unsupported hot reload because both can discard active work or
  misrepresent runtime behavior.
- **Unknown data is read-only evidence** — expose key/name/count and a source-file action, but do
  not model raw content in Control; rejected whole-file display/edit because it increases secret and
  accidental-rewrite exposure.
- **Viewer before writer** — first ship real discovery and provenance, then add a writer through
  the SDD 442 adapter; rejected coupling a new Control screen to home-file mutation because a visual
  prototype is not sufficient evidence for preserving a user-owned native configuration file.

## Files touched

- `src/runtime-config/*` — adapter-neutral inventory, source scope, read/write result and freshness
  types plus Codex implementation.
- `src/webview/Cockpit.ts`, `src/webview/cockpit/messages.ts` — host actions and localized strings.
- `src/webview/cockpit/main.tsx`, `src/webview/cockpit/App.tsx`, `cockpit.css` — live Runtime Config
  model, edit state, save/error/pending presentation.
- `src/workspace/Workspace.ts` / agent lifecycle collaborators — affected-agent detection and
  Start/Restart/Resume freshness acknowledgement.
- `docs/runtimes/parity.md` — evidence and limits for every added runtime adapter.
- `test/unit/runtimeConfig*.test.ts`, cockpit/action tests and lifecycle tests — fixed regression
  evidence for source preservation and application timing.

## Risks & unknowns

- Native config source discovery varies by runtime and may be altered by environment overrides.
- A source may contain comments, unknown keys, symlinks or malformed data; adapters must refuse
  unsafe writes rather than normalize it silently.
- Global configuration can affect several agents, but only agents selecting that source should be
  marked pending.
- The existing canonical private-home projection must remain the final launch authority; this
  surface manages source state, not a bypass around the harness.
- Resume is a new process continuing a transcript, not a generic hot-reload promise; capability
  changes must be recomputed and made visible at that boundary.

## Visual impact

Control's Runtime label becomes Runtime Ops and Runtime Config is a neighboring top-level tab. The
new tab must make scope, source file, individual items, unknown-data boundary, affected agents and
pending-application state legible without becoming a raw config editor. Capture installed Dev Host
screenshots for global and workspace states after each visible slice.

## Sources consulted

- `docs/architecture/agent-native-config-inheritance.md`
- `docs/runtimes/parity.md`
- `docs/specs/442-codex-native-config-adapter/*`
- `src/harness/HarnessManager.ts`
- `src/agents/AgentManager.ts`
- `src/webview/Cockpit.ts`
- `src/webview/cockpit/{App,messages,main}.tsx`
