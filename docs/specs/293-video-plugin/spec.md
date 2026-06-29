# 293 — video-plugin (paid generative)

_Created 2026-06-29._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

Migrate the **paid / generative** half of the split video capability as the Tachyon **`video`** plugin (sibling of
the shipped `hyperframes`, which is the local/deterministic half). Generate organic/photoreal motion via **fal.ai
video models** (Wan / Kling / Veo class) through the fal **queue** REST API. This is the image/sound API-plugin shape
extended to **ASYNC** — a clip takes ~5 min and costs **$0.50–$3** (100–1000× an image), so it is **fire-and-forget**
(submit → poll across separate invocations, via a gitignored job ledger) with a **HARD `--confirm-cost-usd` gate**.

Tiers (from a bundled oracle): **draft** (Wan ~$0.10/s, ≤5s, image-to-video), **standard** (Kling ~$0.112/s, ≤15s,
image-to-video), **premium** (Veo ~$0.40/s, ≤8s, text/image, audio). Most tiers are **image-to-video** — they need a
source image (`--image-url`), which the user supplies (the sibling `image` plugin can produce one).

## Dependency shape (engine-first)

| Dependency | Model | Note |
|---|---|---|
| `curl` + `jq` | external tools (285) | the fal queue REST client + body/url parsing — resolved TRUSTED via the shim (NOT bare), as in image/sound |
| `ffmpeg` | external tool (285), OPTIONAL | only if we re-encode/normalize the downloaded clip |
| `FAL_KEY` | env (skill reads it) | SECRET — never stored/echoed; unset → `unavailable` |
| the job LEDGER | gitignored `.tachyon/` state | request_ids persisted so `poll` reaps across invocations — plugin-script state, not a new engine |

Hoped-for outcome: **NO new engine** — the async/poll/ledger + cost gate are all plugin-script logic on top of the
existing external-tool + env-key shape (image/sound). Confirm in the design dueto.

## Acceptance criteria

- [ ] **Scenario: fail-closed without a key** — `FAL_KEY` unset → `unavailable`, never a paid call
- [ ] **Scenario: HARD cost gate** — `submit` REFUSES unless `--confirm-cost-usd ≥ estimate` (estimate = price × duration),
      and prints the estimate; NO queue call fires below the ceiling
- [ ] **Scenario: async submit → ledger → poll** — `submit` posts to the fal QUEUE, persists `{request_id, model,
      estimate, output}` to a gitignored ledger, and returns immediately (never blocks polling); `poll` reaps terminal
      jobs (status → result → download the clip), idempotently
- [ ] curl/jq surface as external tools on the drawer/card (285/287); missing → `unavailable`
- [ ] image-to-video tiers require a source `--image-url`; text-capable tiers don't — validated
- [ ] self-contained in `tachyon-plugins/video/` (manifest + skill + fal queue client + tier oracle + README); zero Agent0 refs
- [ ] NO new engine (the ledger is gitignored `.tachyon/` state, not a capability)
- [ ] **PAID-action safety (critical — a clip is $0.50–$3):** the headless dogfood NEVER fires a real generation — it
      mocks the fal queue (submit/poll), proving the cost-gate refusal, the ledger write/reap, fail-closed, and that no
      network call precedes the confirm gate. A real generation is a separate, explicitly user-authorized step.

## Non-goals

- The local/deterministic lane (the shipped `hyperframes` plugin).
- Higgsfield / alternative providers (fal.ai only in v1; oracle-documented).
- A per-session budget counter (per-call gate only, mirroring image/sound/the Agent0 video).
- Generating the source image (use the `image` plugin or a user-supplied URL).

## Open questions

- **OQ1 — the async/ledger design.** Where does the ledger live (`.tachyon/video-jobs/ledger.jsonl`, gitignored)? Is
  `submit` + `poll` (separate invocations) the right shape for a Tachyon plugin, or should a single skill call
  submit-then-poll-with-timeout? Lean: keep fire-and-forget (submit returns request_id + ledger; poll reaps) — never
  block the agent on a ~5-min render. How does `poll` handle terminal vs in-progress vs failed; idempotency; cleanup?
- **OQ2 — the cost gate as an agent contract.** Even harder than sound ($0.50–$3). `--confirm-cost-usd ≥ estimate` is
  required; the SKILL must state an agent passes it ONLY on explicit user spend authorization (never auto). Is the
  run-time gate the right layer (install consent flags nothing paid)? Should the estimate-vs-actual overrun be
  recorded-and-warned (the job is already billed by the time an overrun shows)?
- **OQ3 — image-to-video input.** draft/standard need `--image-url`. Validate it's an https URL; how to surface that a
  tier needs an image (the oracle carries an `input` field?). premium (Veo) text-capable. Confirm the per-model body
  shape via the oracle (model/body-fields/output-url-jq/price/max-duration/input-kind).
- **OQ4 — reuse the fal client.** Copy the image/sound inline curl fal client and EXTEND it for the QUEUE API
  (submit/status/result, not just sync `run`)? Two-plugin-copy decision (291 D2) stands — copy, don't share a dep.
- **OQ5 — NO new engine?** Confirm the ledger-as-gitignored-state + the async poll need nothing engine-side. If a
  first-class "background job" or "scheduled poll" capability would help, name it engine-first (but lean: not needed —
  the agent re-invokes `poll`).

## Context / references

- spec 291 (image/sound) — the API-plugin shape (fal REST + FAL_KEY + curl/jq external + cost gate) to extend to async.
- spec 292 (hyperframes) — the deterministic sibling; the split rationale.
- The source: Agent0 `/video` `--mode generative` (`gen.sh` prepare/submit/poll/record + `video-tiers.yaml`) + the
  shared `fal-rest.sh` queue primitives (submit/status/result/download) — the behavioural contract (the fire-and-forget
  ledger, the hard cost gate, the tier oracle).
