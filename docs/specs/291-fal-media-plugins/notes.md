# 291 — fal-media-plugins (image + sound) — notes

_Created 2026-06-29._

## Implementation (2026-06-29)

The first **API-plugins** (paid fal.ai REST; env-key; no provisioned binary/data), in `tachyon-plugins/image/` +
`tachyon-plugins/sound/`. Each is self-contained: manifest + skill + an inline curl fal client + README; sound also
ships `references/sound-tiers.json` (the tier oracle — a bundled payload, NOT manifest data, D5).

- **curl + jq** = external tools resolved via `_tachyon-external <plugin> <tool>` (trusted abs paths, never bare —
  D1); sound adds **ffmpeg** (optional, mp3). **FAL_KEY** = env (D4), unset → `unavailable`.
- **Cost gate at run time** (D3): both print `estimated: $X …` before any paid call. image `--tier` required
  (3-option error). sound cost = price×duration from the oracle, HARD `--confirm-cost-usd` refusal above $0.25,
  checked BEFORE any network call. SKILL/README/description loudly mark PAID; never auto-confirm.
- Output contained to the workspace + temp+`mv -f` (no symlink follow) + git-ignore aware (D6). NO new engine (D0).

## Impl codex dueto (NEEDS-REVISION) — all folded (commit becc0e2)

- **HIGH** — FAL_KEY could leak: both printed the raw authenticated fal response body on a non-200. Fix: print only
  HTTP + model + a jq-parsed safe field; never the raw body.
- **HIGH (sound)** — `--duration 0` → $0.00 estimate → bypassed the confirm gate before a premium paid call. Fix:
  require duration ≥ 1.
- **MEDIUM** — PATH-poison: ambient tools (git/awk/sha…) could be hijacked (a fake `git` → fake root → fake shim;
  any spawned tool inherited FAL_KEY). Fix: sanitize PATH to system dirs at the top; copy FAL_KEY to a non-exported
  var + `unset FAL_KEY` + pass the auth header via a 0600 `curl --config` file (not argv → not ps-visible, not env →
  not inherited).
- **MEDIUM (sound)** — the oracle `output_url_path` is interpolated into a jq filter (data→code if tampered). Fix:
  strict dotted-field regex validation before use.
- **LOW (sound)** — temp output left on a rare `cp` failure under `set -e`. Fix: `rm -f` the temp on failure.
- Dueto crux confirmed good: provenance never includes the prompt or key; containment + `mv -f` correct; image's
  print-only (no hard gate) matches the folded design (cheap tiers); awk boundary math correct.

## Headless dogfood — full pass (real engine, NO paid call)

For BOTH plugins: install (no data) → lockfile records curl/jq[/ffmpeg] externals → shim + skill materialized →
`_tachyon-external <plugin> curl` resolves `/usr/bin/curl` (trusted); `jq` is user-local on the host so the shim
correctly returns `unavailable` (anti-spoof demonstrated) → skill fail-closes without FAL_KEY → a MOCK-curl flow
(dummy key, fake fal JSON) reaches `status=ok` (image jpg / sound wav) → sound premium-30s ($0.40) is refused before
any network call. A real paid generation remains a separate, explicitly user-authorized step.

## Pricing / verification caveats

Tier prices/models are representative (image: flux/schnell ~$0.003, gpt-image-2 ~$0.04+, imagen4/ultra ~$0.06;
sound oracle dated). The sound **premium** endpoint (`fal-ai/elevenlabs/music`) is UNVERIFIED (oracle note) — confirm
at first real premium call (the oracle is the single edit point). Verify fal endpoints/prices before relying on them.

## Remaining

NOT pushed/tagged — ready for `tachyon-plugins` v0.19.0 (two plugins) on the owner's nod; no extension bump needed.
ElevenLabs/audio-remote integration is still a separate future plugin (distinct from sound, which is music/SFX).
