# 410 — cockpit-single-app — plan

_Drafted 2026-07-18 from agreed intent. Grounded in repo inventory + current Control embed path._

## Approach

Treat **visual consistency as an architecture property**: one editor Preact runtime owns the
page shell; surfaces become **sections** (or lazy children), not peer apps.

```
Today                         Target
-----                         ------
sidebar App  ─────────────►  sidebar App  (unchanged)
cockpit App  ─┬─ embeds ──►  cockpit App
activity App ─┤                 ├─ shell (PageChrome, pad, nav)
approval App ─┤                 ├─ sections/* (in-tree)
plugins App  ─┤                 └─ lazy studios/*
… 20+ mains  ─┘
host: N WebviewPanel managers   host: cockpit panel (+ temporary thin hosts)
```

### Phase A — Foundation (this spec’s first shippable increment)

1. **Contract in code + docs**
   - STYLEGUIDE: “two apps only” + editor shell (already partial) + “no new webview main”.
   - `CockpitSectionId` remains the nav spine; extend as sections migrate (do not fork a
     second router).
   - Document section module interface:
     ```ts
     // conceptual
     type CockpitSectionModule = {
       id: CockpitSectionId | StudioSectionId;
       title: string;
       hint?: ComponentChildren;
       actions?: (ctx) => ComponentChildren;
       Body: ComponentType<SectionBodyProps>;
     };
     ```
   - Shell always wraps `Body` with `PageChrome` + `.ds-page` pad unless section opts into
     `chrome: "none"` (pure canvas — rare; kanban may use chrome for title row only).

2. **Guard**
   - Unit test or build-time list of allowed `src/webview/*/main.tsx` entries (snapshot).
   - New directory + main without allowlist update → fail.
   - Ban surface CSS patterns already painful: `.approval-root button`, per-header `.ds-btn`
     metric overrides (fixture scan expandable).

3. **Host routing**
   - Map existing commands (`openApprovals`, open Board, open Plugins, …) to
     `openCockpit({ section })` when the section is native; keep legacy panel open only for
     not-yet-migrated IDs.
   - Serializer: persist `{ viewType: cockpit, section }` (Cockpit already has section state —
     harden and document).

4. **First native in-tree pilot (proves foundation)**
   - Prefer a **small** already-embedded Control section (e.g. Approvals or Runtime Ops body
     already co-loaded) rendered as a real Preact child import instead of a second conceptual
     app — exact pilot chosen at implementation start from lowest-risk embed.
   - Success = pilot uses shell only; no second pad; Fleet-comparable header; visual QA note.

### Phase B — Migrate Control embeds (order)

Migrate what Control already co-loads / deep-links first (shared human path):

| Order | Surface | Notes |
|------:|---------|--------|
| 1 | Approvals | Was worst shell offender; good proof |
| 2 | Runtime Ops | Already Control-oriented |
| 3 | Validations | Native-ish in cockpit already |
| 4 | Plugins | Drop sticky head path permanently |
| 5 | tmux inspector | Embed host pad discipline |
| 6 | Board (mission) | Heaviest; keep kanban body CSS |
| 7 | Overview/Engine/Fleet/Worktrees/Deliveries/Settings | Already cockpit-native ModuleChrome — ensure shell-only |

Each row = own task/PR under this spec; update allowlist; visual QA vs Fleet.

### Phase C — Standalone panels → cockpit sections

| Order | Surface | Host today |
|------:|---------|------------|
| 1 | Task detail | TaskDetailPanel |
| 2 | Handoff | HandoffPanel |
| 3 | Activity | ActivityPanel |
| 4 | Probes | ProbeResultPanel |
| 5 | Pin preview | pin-preview |
| 6 | control-inspector / server-inspector | separate panels — fold or deep-link |

Pattern: command opens cockpit+section; delete or gut old panel manager when unused.

### Phase D — Studios

- Keep `StudioFrame` as **layout primitive** inside cockpit routes (`studio/task`, `studio/pin`, …).
- Lazy `import()` per studio to protect cockpit TTI.
- Shared studio shells (command/runbook/schedule/terminal/agent) become section modules
  sharing one frame.

### Phase E — Cleanup

- Remove dead bundles from build graph.
- CI guard: no resurrected mains.
- Optional cookbook for operators (“how to add a section”).

## Key decisions

| Decision | Choice | Rejected |
|----------|--------|----------|
| App count | **2** (sidebar + cockpit) | 1 mega-app; keep 23 |
| Sidebar | **Frozen** separate bundle | Merge into cockpit |
| Migration | **Foundation → screen-by-screen** | Big-bang |
| Shell | **PageChrome + page-pad tokens + kit Button** | Per-surface headers |
| Kit | Keep Preact `shared/ui` (+ vendored kit) | npm shadcn rewrite |
| Bundle | **Lazy sections** after pilot | Single unsplit chunk forever |
| Dual path | Temporary thin host OK | Permanent dual UI |

## Files / areas (foundation)

| Area | Paths |
|------|--------|
| Model / nav | `src/cockpit/model.ts`, `src/webview/cockpit/*` |
| Host open | `src/webview/Cockpit.ts`, command registrations in `extension.ts` / open* helpers |
| Shell / DS | `src/webview/shared/ui/patterns.tsx`, `design-system.css`, `docs/STYLEGUIDE.md` |
| Guard | `test/unit/webviewComponentKit.test.ts` or new `cockpitAppInventory.test.ts` |
| Pilot surface | TBD among approvals / runtime-ops / validations |

## Risks

| Risk | Mitigation |
|------|------------|
| Cockpit bundle bloat | Dynamic import per section; measure dist size on pilot |
| Embed CSS co-load bleed | Stop co-loading foreign sheets as sections go in-tree; one CSS graph |
| Serializer / reload loses section | Explicit state in panel serializer + test |
| Mid-migration dual open paths | Feature flag or section registry `host: "legacy" \| "cockpit"` |
| Studios break isolation assumptions | Keep StudioFrame; only change mount parent |
| Parallel plugin-runtime work conflicts | This spec does not touch plugin engine; UI Plugins section only |

## Sources consulted

- Conversation 2026-07-18: two-app decision; sidebar unchanged; gradual migration.
- Inventory: 23× `src/webview/**/App.tsx`, 24× `main.tsx`.
- `src/cockpit/model.ts` — `CockpitSectionId` + order.
- `src/webview/Cockpit.ts` — panel host / section titles.
- Panel managers: Activity, Approval, Handoff, MissionControl, TaskDetail, studios base.
- STYLEGUIDE + specs 252/282/342 lineage (tokens/kit); DS free-run 0.56.61–71 shell work.
- SDD skill: `.tachyon/plugins/sdd/skills/sdd/SKILL.md`.

## Visual risk

High for every migrated surface. Foundation pilot + each Phase B/C slice requires visual QA
against **Fleet** page shell (pad, title, hint, button height). Sidebar not in visual gate for
this spec except “unchanged”.
