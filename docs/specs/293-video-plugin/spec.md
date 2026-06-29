# 293 — video-plugin (paid generative)

_Created 2026-06-29._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** Shipped 2026-06-29 in `tachyon-plugins/video/` (manifest + `skills/video/{SKILL.md,README.md,scripts/video.sh}` + `references/video-tiers.json`). Both codex duetos folded — design (SHIP-WITH-CHANGES → D0–D9) and impl (NEEDS-REVISION/BLOCKER → all folded in `59a7946`): the FAL_KEY auth is scoped to constructed `queue.fal.run` status/result URLs only (the CDN clip download carries no auth), a transient download failure stays re-pollable, request_id is validated at submit + every ledger field re-validated on poll read, ledger writability is preflighted before the paid POST, premium priced at the $0.60/s worst-case ceiling, and a portable base64 helper. Verified by a headless install dogfood (engine `applyInstall` → lockfile records curl+jq, `_tachyon-external` shim materialized, both resolve trusted) plus a full MOCK submit→poll harness — NO real paid fal call (D9). Pending release: tachyon-plugins `v0.21.0` + the site "NEW IN" banner bump, on the owner's OK.

## Design decisions (folded from the 2026-06-29 codex design dueto — SHIP-WITH-CHANGES → all folded)

- **D0 — NO new engine.** curl/jq external tools + optional ffmpeg + FAL_KEY env + a plugin-owned gitignored ledger +
  agent-invoked `poll`. A background-job engine would be nicer UX later but is NOT a prerequisite.
- **D1 — fire-and-forget `submit` + `poll` (NEVER submit-then-poll-with-timeout).** A ~5-min paid queue job must not
  block an agent turn. `submit` posts to the fal QUEUE, persists the `request_id` to the ledger, returns immediately;
  `poll` (a separate invocation) reaps terminal jobs.
- **D2 — ledger semantics (HIGH).** `.tachyon/video-jobs/ledger.jsonl` = APPEND-ONLY event log; the view is the latest
  event per `request_id`. Events: `submitted` / `completed` / `failed` / `download_failed`, each appended ONLY AFTER
  the terminal action succeeds. `IN_QUEUE`/`IN_PROGRESS` leave the job pending (no destructive rewrite). `poll --all`
  SKIPS jobs whose latest event is terminal. The clip downloads to a temp file inside the contained output dir, then
  `mv -f`. Cleanup/prune is a later affordance, not v1.
- **D3 — concurrent-poll LOCK (HIGH).** `poll` takes a `.tachyon/video-jobs/lock` (mkdir/flock) so two polls can't
  race → double-download / conflicting terminal records. Plugin-local state, not a new engine.
- **D4 — submit crash/orphan + NO auto-retry (MEDIUM, the paid edge).** Write the fal submit response to a temp, then
  append the `submitted` ledger event IMMEDIATELY after parsing `request_id` (minimize the orphan window). Automatic
  retry after an AMBIGUOUS submit failure is FORBIDDEN — it may duplicate a paid generation. Surface the ambiguity to
  the user instead.
- **D5 — HARD cost gate on EVERY submit (not a threshold).** estimate = `price_usd_per_second × duration`; `submit`
  REFUSES unless `--confirm-cost-usd ≥ estimate`, BEFORE any network call, every time. The SKILL/README/description
  state an agent passes `--confirm-cost-usd` ONLY on explicit user spend authorization — never auto. If actual price
  exceeds the estimate, record-and-warn (the job is already billed).
- **D6 — duration bounds HARD (HIGH).** require `1 ≤ duration ≤ tier.max_duration_seconds`, refused BEFORE any
  network call (Agent0 only warned — Tachyon enforces). The cost confirm is meaningful only within the model's limits.
- **D7 — oracle input contract (MEDIUM).** The tier oracle carries `model`, `price_usd_per_second`,
  `max_duration_seconds`, `input_kind` (`image` | `text_or_image`), `requires_image_url`, `output_url_path`, and the
  body field names. draft/standard FAIL without `--image-url`; premium allows text-or-image. Validate `--image-url`
  is `https://…` (reject non-HTTPS); pass it to the fal body but NEVER fetch/proxy it locally (fal fetches it).
- **D8 — copy + EXTEND the fal client for the QUEUE API** (291 D2 two-plugin-copy stands — no shared dep): add
  `submit`/`status`/`result`/`download`, and REAPPLY all 291 hardening — sanitized PATH, `_tachyon-external` for
  curl/jq (never bare), `FAL_KEY` copied to a non-exported local + `unset` + auth via a 0600 `curl --config`, NEVER
  print a raw authenticated response body, strict `output_url_path` dotted-field regex before the jq, contained downloads.
- **D9 — PAID-DOGFOOD safety (a clip is $0.50–$3).** The headless dogfood NEVER fires a real generation: it MOCKS the
  fal queue (submit → fake request_id; poll → COMPLETED + a fake CDN url; a fake download), proving the cost-gate
  refusal (no network below the ceiling), the ledger write+reap, and fail-closed without FAL_KEY. A real generation is
  a separate, explicitly user-authorized spend step.

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

- [x] **Scenario: fail-closed without a key** — `FAL_KEY` unset → `unavailable`, never a paid call
- [x] **Scenario: HARD cost gate** — `submit` REFUSES unless `--confirm-cost-usd ≥ estimate` (estimate = price × duration),
      and prints the estimate; NO queue call fires below the ceiling
- [x] **Scenario: async submit → ledger → poll** — `submit` posts to the fal QUEUE, persists `{request_id, model,
      estimate, output}` to a gitignored ledger, and returns immediately (never blocks polling); `poll` reaps terminal
      jobs (status → result → download the clip), idempotently
- [x] **Scenario: poll is idempotent + locked** — `poll --all` reaps terminal jobs once (skips already-terminal), is
      guarded by `.tachyon/video-jobs/lock` against concurrent double-download, and leaves IN_QUEUE/IN_PROGRESS pending
- [x] **Scenario: duration bounds** — `submit` refuses (before any network) if duration < 1 or > the tier's `max_duration_seconds`
- [x] **Scenario: ambiguous submit is NOT auto-retried** — on an ambiguous submit failure the script surfaces it (no
      auto-retry → never double-bills)
- [x] curl/jq surface as external tools on the drawer/card (285/287); missing → `unavailable`
- [x] image-to-video tiers require a validated `https://` `--image-url` (rejected if non-HTTPS; never local-fetched);
      text-capable tiers don't (oracle `input_kind`/`requires_image_url`)
- [x] the ledger is append-only with a latest-event-per-request_id view; terminal events appended only after the
      terminal action succeeds; downloads temp+`mv -f` into the contained output dir
- [x] all 291 client hardening reapplied (PATH sanitize, shim curl/jq, FAL_KEY via 0600 curl --config + unset, no raw
      body print, oracle output_url_path regex)
- [x] self-contained in `tachyon-plugins/video/` (manifest + skill + fal queue client + tier oracle + README); zero Agent0 refs
- [x] NO new engine (the ledger is gitignored `.tachyon/` state, not a capability)
- [x] **PAID-action safety (critical — a clip is $0.50–$3):** the headless dogfood NEVER fires a real generation — it
      mocks the fal queue (submit/poll), proving the cost-gate refusal, the ledger write/reap, fail-closed, and that no
      network call precedes the confirm gate. A real generation is a separate, explicitly user-authorized step.

## Non-goals

- The local/deterministic lane (the shipped `hyperframes` plugin).
- Higgsfield / alternative providers (fal.ai only in v1; oracle-documented).
- A per-session budget counter (per-call gate only, mirroring image/sound/the Agent0 video).
- Generating the source image (use the `image` plugin or a user-supplied URL).

## Open questions

_All resolved by the 2026-06-29 design dueto — see § Design decisions D0–D9._

- **OQ1 — async/ledger.** RESOLVED → D1/D2/D3: fire-and-forget submit+poll; append-only ledger w/ terminal-after-action; poll lock.
- **OQ2 — cost gate.** RESOLVED → D5: hard `--confirm-cost-usd ≥ estimate` on EVERY submit; record-and-warn on overrun.
- **OQ3 — image-to-video input.** RESOLVED → D7: oracle `input_kind`/`requires_image_url`; https-validated `--image-url`, no local-fetch.
- **OQ4 — fal client.** RESOLVED → D8: copy + extend for queue; reapply 291 hardening.
- **OQ5 — new engine.** RESOLVED → D0: none.

## Context / references

- spec 291 (image/sound) — the API-plugin shape (fal REST + FAL_KEY + curl/jq external + cost gate) to extend to async.
- spec 292 (hyperframes) — the deterministic sibling; the split rationale.
- The source: Agent0 `/video` `--mode generative` (`gen.sh` prepare/submit/poll/record + `video-tiers.yaml`) + the
  shared `fal-rest.sh` queue primitives (submit/status/result/download) — the behavioural contract (the fire-and-forget
  ledger, the hard cost gate, the tier oracle).
