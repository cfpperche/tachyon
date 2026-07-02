# 324 — activity-share-actions

_Created 2026-07-02._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Pin `p-04347b` asks for "Share de Activity", but that is really two related product flows:

1. external sharing, like a browser Share button, where a user sends a message or Activity row to a channel
   outside Tachyon such as email or WhatsApp; and
2. internal sharing, where a user sends a message or Activity row directly as input to another Tachyon agent
   session.

Done means a user can act on a useful Activity item without manually selecting text from the transcript, while
the destination receives enough provenance to know which agent, item kind, and timestamp the snippet came from.

## Acceptance criteria

- [x] **Scenario: external share from a text Activity item**
  - **Given** an Activity panel showing a text-bearing item
  - **When** the user chooses that item's external Share action and picks a channel
  - **Then** Tachyon previews the bounded payload before opening the chosen external target with URL-encoded content, or copies the content when that channel needs clipboard handoff
- [x] **Scenario: internal share into another agent**
  - **Given** at least one other running Tachyon AI agent exists in the same workspace
  - **When** the user chooses "Send to agent" for a text-bearing Activity item and picks a destination agent
  - **Then** Tachyon pastes a formatted prompt into the destination agent's live terminal session without submitting it
- [x] **Scenario: internal destination picker excludes invalid targets**
  - **Given** some agents are stopped, dead, non-AI terminal entries, or the same agent as the source Activity panel
  - **When** the internal destination picker is shown
  - **Then** those invalid destinations are not selectable
- [x] **Scenario: shared payload includes provenance**
  - **Given** a text-bearing Activity item has source agent, item kind, timestamp, and content
  - **When** it is shared externally or internally
  - **Then** the payload includes source agent name, Activity kind, timestamp when available, and the item content
- [x] **Scenario: unsupported item has no share affordance**
  - **Given** an Activity item has no meaningful text payload
  - **When** the feed renders
  - **Then** that item does not expose share actions
- [x] **Scenario: stale item is not shared**
  - **Given** an Activity item changed or fell out of the host's current rendered window after the webview rendered it
  - **When** the user tries to share it
  - **Then** Tachyon refuses the action with a clear "item no longer available" message
- [x] Share controls do not clutter the resting Activity feed; they appear on hover/focus for supported items.

## Non-goals

- Arbitrary browser text-selection sharing. v1 shares one rendered Activity item at a time.
- Native OS/mobile share-sheet integration. VS Code webviews do not give a stable cross-platform share surface.
- Binary image sharing. Image rows can be handled in a later slice; this spec focuses on text-bearing Activity rows.
- Auto-submitting internal shares. v1 stages the prompt in the target terminal; the human or receiving agent must submit.
- Sending input to stopped agents. v1 sends only to currently running AI agents.

## Open questions

- Should a later v2 add an explicit "send and submit" action? Out of scope for v1 because Activity content may contain
  untrusted model output or injected context.
