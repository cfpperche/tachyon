# 291 — fal-media-plugins (image + sound)

_Created 2026-06-29._

**Status:** shipped

**Closure:** image + sound built in `tachyon-plugins/{image,sound}/` (the first API-plugins). Both codex duetos folded
(design SHIP-WITH-CHANGES → no new engine; impl NEEDS-REVISION → all findings resolved: FAL_KEY never leaks via the
response body, sound --duration ≥1 closes the gate-bypass, PATH-poison hardening + non-exported key + curl --config,
oracle output_url_path is regex-validated against jq-injection, temp cleaned on cp failure). Headless dogfood passed
for BOTH via the real engine WITHOUT any paid call: install → `_tachyon-external curl` resolves /usr/bin/curl (jq
correctly unavailable as user-local — anti-spoof) → fail-closed without FAL_KEY → mock-curl flow status=ok → sound
premium-30s ($0.40) refused before any network call. tachyon-plugins commits: `feat(image,sound)` + fold `becc0e2`.
NOT pushed/tagged (awaiting nod). See notes.md.
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Design decisions (folded from the 2026-06-29 codex design dueto — SHIP-WITH-CHANGES → all folded)

- **D0 — NO new engine (confirmed).** The API-plugin shape is fully expressible today: `externalTools` (curl/jq) +
  a skill-owned `FAL_KEY` env check + a run-time cost gate. A first-class "secret/env requirement" or "paid" manifest
  field would be nice card UX LATER but does NOT exist (unknown top-level manifest fields fail closed) — 291 must not
  depend on it.
- **D1 — curl + jq are external tools (285), USED at runtime via the shim (codex HIGH).** Not bare `curl`/`jq`: the
  ported fal client resolves `curl`, `jq` (+ optional `ffmpeg`) via `.tachyon/bin/_tachyon-external <plugin> <tool>`
  and executes those TRUSTED absolute paths (`detect:["--version"]`, assist-install apt/dnf/pacman/brew). A PATH-poison
  test (fake workspace curl/jq) proves the bare names are never used.
- **D2 — two independent plugins** (`image`, `sound`), each copying the ~200-line fal client. A shared `fal-core` via
  plugin-deps (276) is premature — revisit only on a third fal plugin / real client drift.
- **D3 — the COST GATE lives at RUN time, in the script** (NOT install consent — there's no MCP/tool/git-hook, so
  install flags nothing paid). image PRINTS `estimated: $X …` before any paid call; sound HARD-refuses above $0.25
  without `--confirm-cost-usd`. The skill/README/manifest `description` LOUDLY say **paid + needs FAL_KEY**; the SKILL
  instructions must state an agent may pass `--confirm-cost-usd` ONLY when the user explicitly authorized that spend
  — never auto-supplied.
- **D4 — FAL_KEY is an env contract, leak-safe.** Read from env; unset → `unavailable`; NEVER echoed/stored/provisioned.
- **D5 — `sound-tiers.yaml` ships as a PLUGIN PAYLOAD file** (bundled source the script reads), NOT manifest `data`
  (which is for fetched sha-pinned artifacts).
- **D6 — output containment is enforced at exec/download** (re-checked, not just at prepare): reject absolute/escaping
  paths; drafts → gitignored generated dir, brand/assets → tracked; never auto-stage.
- **D7 — PAID-DOGFOOD safety:** the headless dogfood NEVER fires a real paid fal call. It installs/previews, surfaces
  curl/jq, fails closed without FAL_KEY, runs the prepare/cost path with a DUMMY key + a MOCKED fal REST (a fake curl),
  and proves sound's over-threshold refusal fires BEFORE any network call. A real generation is a separate,
  explicitly user-authorized step (money).

## Intent

Migrate the `image` + `sound` capabilities into Tachyon plugins — the FIRST **API-plugins** (env-key + paid REST,
NO provisioned binary/data/tool), proving a new plugin shape after the three local tool-plugins (transcribe/diagram/
audio). Both call the **fal.ai** REST API (`Authorization: Key $FAL_KEY`):

- **image** — `fal.run/<model>` SYNC; tiers `draft` (flux/schnell ~$0.003), `brand-text` (gpt-image-2 $0.04–0.20),
  `brand-photo` (imagen4/ultra ~$0.06); `--aspect`; output draft→gitignored mockups / brand→tracked; **prints the
  estimated cost BEFORE the call**.
- **sound** — paid creative audio (music + sfx); a data-driven tier oracle (`sound-tiers.yaml`: model / body fields /
  output-url jq path / price / unit); `--kind music|sfx`, `--tier`, `--duration`; cost = price × duration; a **hard
  `--confirm-cost-usd` gate above $0.25**.

Both ship: a self-contained fal REST client (port of `fal-rest.sh`, cleaned of harness refs), a `description`-
selectable skill + script (port of `gen.sh` / `sound.sh`, the Agent0 capacity-kit deps inlined), and the tier oracle.
Local-only-of-secrets: the plugin NEVER stores `FAL_KEY` (read from env; fail-closed `unavailable` when unset).

### Dependency shape (the engine-first check)

| Dependency | Existing model | Note |
|---|---|---|
| `curl` | external tool (285) | the fal REST client; a system binary, trust-gated via `_tachyon-external` |
| `jq` | external tool (285) | build the request body + extract the asset URL; system binary |
| `ffmpeg` | external tool (285), OPTIONAL | image dim-reconcile (gpt-image-2); not required |
| `FAL_KEY` | env (skill reads it) | a SECRET — never provisioned/stored; unset → `unavailable` |
| the fal model | none | the paid REST endpoint; nothing to provision |

Hoped-for outcome: **NO new engine** — the API-plugin shape is just `externalTools` (curl/jq) + an env-key check +
the paid cost gate in the script. (Confirm in the design dueto.)

## Acceptance criteria

- [ ] **Scenario: fail-closed without a key**
  - **Given** `FAL_KEY` is unset
  - **When** the image/sound skill runs
  - **Then** it reports `unavailable` with how to set `FAL_KEY` — never a silent failure, never a partial call
- [ ] **Scenario: cost printed before the call**
  - **Given** a valid tier + prompt (+ key)
  - **When** the skill runs
  - **Then** it prints `estimated: $X.XXX for <model> …` BEFORE any paid request fires
- [ ] **Scenario: sound hard cost gate**
  - **Given** an estimate above the confirm threshold ($0.25) without `--confirm-cost-usd`
  - **Then** it refuses (no paid call) and tells the user to pass `--confirm-cost-usd`
- [ ] image: `--tier` required (the 3-option error when omitted); output path mechanical (draft gitignored / brand tracked)
- [ ] both: `curl`/`jq` surface as external tools on the drawer/card (285/287); missing → `unavailable`
- [ ] self-contained in `tachyon-plugins/{image,sound}/` (manifest + skill + fal client + tier oracle + README); zero Agent0 refs
- [ ] NO new engine (D0 — externalTools + env-key + cost gate only)
- [ ] **PAID-action safety:** the headless dogfood does NOT fire a real paid fal call (money) — it validates install +
      fail-closed + cost-estimate + the gate; a real generation is a separate, explicitly user-authorized step

## Non-goals

- Storing/provisioning `FAL_KEY` (it's a secret; env only).
- A local/free lane (these are paid by nature — the `/audio` local analog is the separate audio plugin).
- The fal-ai MCP discovery server (optional; the skill uses REST curl directly, per the Agent0 spec-088 rationale).
- Video (a later dual-mode plugin) and brand-pipeline orchestration.

## Open questions

_All resolved by the 2026-06-29 design dueto — see § Design decisions._

- **OQ1 — curl/jq.** RESOLVED → D1: external tools, used via the shim (not bare).
- **OQ2 — one vs two plugins.** RESOLVED → D2: two independent, copy the fal client.
- **OQ3 — cost gate.** RESOLVED → D3: run-time script gate + loud "paid" + never auto-confirm.
- **OQ4 — new engine?** RESOLVED → D0: none.

## Context / references

- The three shipped local tool-plugins (transcribe/diagram/audio) — the plugin shape; this proves the API variant.
- spec 285 (external tools) — curl/jq; spec 287 (install-UX) — card surfacing.
- The source: Agent0 `image` skill (`scripts/gen.sh`) + `sound` (`sound.sh` + `sound-tiers.yaml`) + the shared
  `fal-rest.sh` (the curl REST client to port) — the behavioural contract (tiers, cost-print, the confirm gate).
