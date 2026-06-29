# 291 — fal-media-plugins (image + sound)

_Created 2026-06-29._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

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

- **OQ1 — curl/jq: external tools or assumed?** Lean: declare both as external tools (285) — system binaries, honest
  surfacing on the card, assist-install apt/dnf/pacman/brew (the ffmpeg pattern). Confirm vs "assume + unavailable".
- **OQ2 — one plugin or two?** Two separate plugins (`image`, `sound`) sharing a copied fal client, OR a plugin
  dependency (276) so `sound` depends on a shared `fal-core`? Lean: two independent plugins, each shipping its own
  copy of the small fal client (no shared-dep complexity for ~200 lines); revisit if a third fal plugin appears.
- **OQ3 — the cost gate as an agent contract.** The skill prints cost + (sound) requires `--confirm-cost-usd` above
  threshold. For an agent invoking the skill, is "print + re-invoke with the flag" the right gate, or should the
  manifest/skill declare the paid nature more loudly (e.g. a consent surface)? Lean: preserve the Agent0 gate (print
  + hard flag); the plugin install consent already flags nothing paid (no MCP/tool) — the COST gate lives in the run.
- **OQ4 — confirm NO new engine** for the API-plugin shape (env-key + paid REST). If a gap appears (e.g. a first-class
  "secret requirement" or "paid-capability" declaration), name it engine-first.

## Context / references

- The three shipped local tool-plugins (transcribe/diagram/audio) — the plugin shape; this proves the API variant.
- spec 285 (external tools) — curl/jq; spec 287 (install-UX) — card surfacing.
- The source: Agent0 `image` skill (`scripts/gen.sh`) + `sound` (`sound.sh` + `sound-tiers.yaml`) + the shared
  `fal-rest.sh` (the curl REST client to port) — the behavioural contract (tiers, cost-print, the confirm gate).
