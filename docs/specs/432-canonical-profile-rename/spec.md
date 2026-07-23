# 432 — Canonical profile rename

_Created 2026-07-22._

**Status:** shipped

**Task:** `t-152041` · **Parent:** `t-c111e4` / SDD 431

**Affected Product Invariants: none —** PI-001 concerns project-guidance ownership and remains unchanged. Prompt composition is not modified.

## Intent

Rename for profile-backed agents still follows the legacy order: it mutates live/session state and `tachyon.yml` before the profile's immutable identity and host authority have a recoverable move. This slice adds stopped-agent persistent rename to the canonical lifecycle boundary. It preserves `agentId`, profile bytes, grants and Evolution identity while moving the source name to an unoccupied destination through one journal and two-name admission lock.

The profile-authority compare-and-move is the irreversible commit point. Before that point recovery may restore the old directory. After it, recovery only rolls forward through locator, Evolution and host activation. Both names remain blocked from launch and reuse until commit or proven compensation removes the journal.

## Phase and recovery contract

| Phase | Durable state | Recovery direction |
|---|---|---|
| `intent` | exact source profile/authority/config/Evolution evidence and target records journaled | restore old |
| `profile-moved` | destination contains the exact non-Evolution home; Evolution remains temporarily under the old name for its signed rename | restore old |
| `authority-moved` | old profile authority absent; destination has the transaction-tagged target | roll forward only |
| `locator-written` | config names destination with the exact canonical pointer | roll forward only |
| `evolution-moved` | no old Evolution profile; destination has the captured `profileId`, or neither existed | roll forward only |
| `activated` | trusted config reload exposes destination while both names are still journal-blocked | commit |
| `committed` | all target states proven; journal removed | complete |

Authority move is idempotent: exact old + absent new performs the move in one host-secret write; absent old + exact transaction target acknowledges a previous success; every other pair degrades. The profile move is verified against a no-follow manifest. Because Evolution already lives inside the agent home, its subtree temporarily remains at the source name and uses Evolution's own signed rename protocol after the profile authority commits. A validated destination Evolution profile with the recorded `profileId` acknowledges replay only after Evolution has verified its complete authority state. Recovery never infers ownership from a name alone.

## Acceptance criteria

- [ ] **Scenario: stopped rename preserves identity**
  - **Given** a stopped profile-backed agent and an unoccupied destination
  - **When** rename commits with the inspected revision
  - **Then** destination has the same `agentId`, canonical bytes, grants and Evolution `profileId`, while source has no authority or locator
- [ ] **Scenario: stale or colliding rename writes nothing**
  - **Given** a stale revision, destination profile/config/authority/Evolution collision or active source agent
  - **When** rename is requested
  - **Then** it fails before the irreversible commit point without exposing authority content
- [ ] **Scenario: authority acknowledgement is replayable**
  - **Given** the authority store committed the move but acknowledgement was lost
  - **When** recovery replays the journal
  - **Then** the exact transaction target is recognized and recovery rolls forward without duplicating authority
- [ ] **Scenario: pre-commit interruption compensates**
  - **Given** interruption before authority move
  - **When** recovery runs
  - **Then** the profile returns to the source name and no destination authority/locator remains
- [ ] **Scenario: post-commit interruption rolls forward**
  - **Given** interruption after authority move
  - **When** recovery runs
  - **Then** locator, Evolution and activation converge at the destination or both names remain degraded and blocked
- [ ] Create/edit/enable/migration and opposing rename operations serialize over the same normalized source/destination locks.
- [ ] Legacy agents continue through the existing rename path unchanged.

## Non-goals

- Moving a running tmux session or live ledger state (`t-c3605c`).
- Forget/retirement or name reuse after deletion (`t-980e6e`).
- Clone, import/export, Agent Studio UI, plugins or runtime-managed memory.
- Supporting live rename for isolated harness or managed Pi sessions.

## Open questions

None. Independent review must challenge the phase table before implementation.
