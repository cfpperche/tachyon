# 438 — agent-profile-studio

_Created 2026-07-22._

**Status:** shipped
**Closure:** Shipped across the four child Tasks, completed by commit `1f1204d4`; Visual QA and isolated Dev Host lifecycle proof are recorded in `notes.md`.
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npx vitest run test/unit/agentStudioAdapter.test.ts test/unit/agentStudioDomain.test.ts`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Replace Agent Studio's legacy last-write-wins path for canonical profile-backed agents with a revisioned, redacted lifecycle experience. Studio may present authored values together with provenance, authority, learned state, runtime projection and diagnostics, but only an explicit allowlisted draft may cross the write boundary. Canonical mutations reuse the lifecycle, rename/forget and portable-bundle services already shipped; `tachyon.yml` remains a pointer and never receives resolved profile values.

The delivery is intentionally split into four reviewable Tasks: the typed snapshot/CAS boundary, explicit lifecycle actions, bundle actions, then presentation/localization/installed proof. Legacy agents keep their current editor until explicitly migrated.

**Affected Product Invariants: none.** PI-001 governs project-guidance delivery. Studio displays only provenance metadata for project guidance and does not change its opt-in composition or fixed oracle.

## Acceptance criteria

- [x] **Scenario: canonical save preserves provenance**
  - **Given** a canonical agent with authored, learned, projected, authority-owned and secret-backed state
  - **When** Studio loads it and saves an explicit authored edit
  - **Then** the write uses `expectedRevision`, only the allowlisted authored patch reaches lifecycle commit, and no derived, learned, authority, projection or secret data is serialized
- [x] **Scenario: concurrent editors fail closed**
  - **Given** two Studio windows loaded at the same revision
  - **When** one commits and the other attempts a stale save
  - **Then** the stale write changes nothing and Studio offers an explicit refresh/retry with a redacted conflict
- [x] **Scenario: lifecycle actions retain their semantics**
  - **Given** a canonical profile
  - **When** enable/disable, rename or forget is requested
  - **Then** the corresponding existing transaction runs; rename preserves `agentId`, forget requires confirmation, and degraded/incomplete state disables unsafe actions
- [x] **Scenario: bundle actions cannot use form state**
  - **Given** clone, import or export from Studio
  - **When** the action runs
  - **Then** Studio calls the portable V1 service with bounded bytes/current snapshot, clone/import mint fresh disabled identities with empty grants, and reauthorization requirements are shown
- [x] **Scenario: legacy compatibility remains explicit**
  - **Given** an agent without a canonical profile pointer
  - **When** Studio loads and saves it
  - **Then** its existing form behavior remains available and no canonical operation is guessed
- [x] New human-visible text is localized in English and pt-BR; keyboard/focus and destructive confirmations are covered.
- [x] Dark, light and high-contrast Visual QA plus installed human dogfood cover create/edit/disable-enable/clone-export-import/rename/forget.
- [x] SDD 429's remaining lifecycle/Studio acceptance and full gates close only after all four child Tasks ship.

## Non-goals

- Automatic three-way merge of stale edits.
- A generic import-plan registry, migration graph or second lifecycle journal.
- Editing or revealing secret values, host authority, runtime-managed memory, plugins or learned content through profile save.
- Removing legacy-agent editing before this workspace has explicitly migrated them.

## Open questions

None. Architecture review `probe-ba265098-ea19-4b80-9f94-8b08fb7ea578` was applied selectively: decomposition and source-of-truth boundaries were accepted; speculative import plans and new secret APIs were rejected as unnecessary for V1.
