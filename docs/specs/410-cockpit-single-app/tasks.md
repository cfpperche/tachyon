# 410 — cockpit-single-app — tasks

_Generated from `plan.md` on 2026-07-18. Work top-to-bottom within a phase. Each migration
surface is its own PR. If a task reveals the plan is wrong, update `plan.md` first._

## Phase A — Foundation

- [ ] Land STYLEGUIDE “two apps” rule + cross-link this spec; no new editor `main.tsx` without allowlist.
- [ ] Add inventory/allowlist test of `src/webview/*/main.tsx` (snapshot of known apps at baseline).
- [ ] Define section module interface + shell wrapper (`PageChrome` + page pad) used by native sections.
- [ ] Harden cockpit section restore (serializer / reopen) and document command → `openCockpit({ section })` map.
- [ ] Choose and implement **one** pilot native in-tree section (Approvals or Runtime Ops or Validations).
- [ ] Visual QA pilot vs Fleet; record Evidence/Verdict in `notes.md`.
- [ ] Remove pilot’s competing shell CSS (bare `button`, double pad, sticky foreign head) if still present.

## Phase B — Control-family migrations (one checkbox group per PR)

- [ ] Migrate Approvals → cockpit section; retire dual path; visual QA.
- [ ] Migrate Runtime Ops → cockpit section; visual QA.
- [ ] Migrate Validations (if not pilot); visual QA.
- [ ] Migrate Plugins; visual QA.
- [ ] Migrate tmux inspector; visual QA.
- [ ] Migrate Board (mission); visual QA (shell only; kanban body may stay).
- [ ] Audit Overview/Engine/Fleet/Worktrees/Deliveries/Settings for shell-only compliance.

## Phase C — Standalone panels

- [ ] Task detail → cockpit section (+ command routing).
- [ ] Handoff → cockpit section.
- [ ] Activity → cockpit section (lazy; heavy).
- [ ] Probes / pin-preview → cockpit section or justified thin host.
- [ ] control-inspector / server-inspector: fold or deep-link decision + implement.

## Phase D — Studios

- [ ] Register studio routes under cockpit; lazy import; StudioFrame preserved.
- [ ] Migrate task-studio, pin-studio, pipeline-studio.
- [ ] Migrate agent/command/runbook/schedule/terminal studio shells.

## Phase E — Cleanup

- [ ] Delete dead bundles/entries from build; shrink allowlist.
- [ ] CI guard stays red on new rogue mains.
- [ ] Optional: `cookbook.md` via sdd-cookbook for “add a section”.
- [ ] Closure line on `spec.md` when foundation+agreed migration tranche is done (or split follow-up specs).

## Verification

_Foundation-focused until Phase A ships; expand Verify as migrations land._

- [ ] Allowlist/inventory test green on main.
- [ ] Pilot section: typecheck + focused unit tests green.
- [ ] Pilot visual QA recorded.

**Verify:** `npm run typecheck && npx vitest run test/unit/webviewComponentKit.test.ts test/unit/uiPatterns.test.ts`

<!-- Add cockpit inventory test path once created, e.g.:
**Verify:** `npx vitest run test/unit/cockpitAppInventory.test.ts`
-->

## Dogfood

**Dogfood-Opt-Out:** Foundation is structural (routing + shell). Headless dogfood of full multi-panel
migration is not meaningful until Phase B pilots land; each migration PR should add a targeted
dogfood or human visual path. Revisit when Approvals or Board is in-tree.

**Human dogfood (foundation):** Reload → open Control → Fleet (baseline) → pilot section → confirm
same page pad, title metrics, button height; sidebar still independent.

## Visual QA

_Required for foundation pilot and every migrated surface._

- Surface: Control cockpit + pilot section; compare to Fleet.
- Risk: double pad, wrong header type, button metric drift, embed CSS bleed.
- After implementation: `Evidence:` path or maintainer note; `Verdict:` pass/fail + fixes.

**Visual QA:** pending foundation pilot (do not opt out of UI shell work).
