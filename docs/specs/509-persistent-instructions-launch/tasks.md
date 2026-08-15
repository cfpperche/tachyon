# 509 — persistent-instructions-launch — tasks

_Generated from `plan.md` on 2026-08-15. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add the pure three-runtime projector with exact serialization and fail-closed byte policy.
- [x] Wire canonical profile instructions into spawn and restart before live-pane mutation.
- [x] Add per-runtime positive, absent, overflow and red-path tests.
- [x] Add the SDD 508 parity dimension and update runtime documentation.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused tests prove all three flags, no empty flags and legible overflow.
- [x] Exact-tree full verification passes.

**Headless check:** `npm run verify:full`
**Verify:** `npm run verify:full`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** authenticated runtime survival was already dogfooded in t-a68138; this slice is launch composition and its executable regressions are the representative proof.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

_Do not create a prototype or evidence file just to satisfy this section. If a durable spec-specific artifact is useful, store it inside this spec directory (for example under `prototypes/` or `evidence/`) and reference its path in backticks after `Prototype:` or `Evidence:`. If it must live elsewhere, declare `**Artifact-Location-Opt-Out:** <reason>`._

**Visual QA Opt-Out:** no web, native UI, or rendered visual surface changes.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <509>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** internal launch projection; operators continue authoring the existing profile field.
