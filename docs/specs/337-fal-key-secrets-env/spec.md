# 337 — fal-key-secrets-env

_Created 2026-07-03._

**Status:** shipped
**Closure:** Shipped 2026-07-03. The paid fal.ai plugins now keep explicit `FAL_KEY` env precedence and fall back to `.tachyon/secrets.env` via a non-executing parser; image/sound/video docs and manifest patch versions were updated, and mocked dogfood proved missing-key, file fallback, and env-wins behavior without paid calls.
**Verify:** `bash -n /home/goat/tachyon-plugins/image/skills/image/scripts/image.sh /home/goat/tachyon-plugins/sound/skills/sound/scripts/sound.sh /home/goat/tachyon-plugins/video/skills/video/scripts/video.sh && ! rg -n '(^|[[:space:]])(source|eval)[[:space:]]+.*secrets\\.env|(^|[[:space:]])\\.[[:space:]]+.*secrets\\.env' /home/goat/tachyon-plugins/image/skills/image/scripts/image.sh /home/goat/tachyon-plugins/sound/skills/sound/scripts/sound.sh /home/goat/tachyon-plugins/video/skills/video/scripts/video.sh`
**Dogfood:** `bash /home/goat/tachyon-plugins/scripts/dogfood-fal-secrets-env.sh`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Paid fal.ai plugins should not require humans to export `FAL_KEY` manually in every shell. Keep the existing
environment-variable path, but add a workspace-local, gitignored fallback that is easy to create and safe enough for
secrets.

## Acceptance criteria

- [x] **Scenario: explicit environment still wins**
  - **Given** `FAL_KEY` is already present in the process environment
  - **When** an image, sound, or video plugin needs fal.ai auth
  - **Then** it uses that value and does not read/override it from a file
- [x] **Scenario: gitignored workspace secret file fills the key**
  - **Given** `FAL_KEY` is absent from the process environment
  - **And** `<workspace>/.tachyon/secrets.env` contains `FAL_KEY=...` or `export FAL_KEY=...`
  - **When** an image, sound, or video plugin needs fal.ai auth
  - **Then** it reads the key from that file and proceeds with the existing cost gates and curl config auth path
- [x] **Scenario: missing key still fails closed**
  - **Given** `FAL_KEY` is absent and `.tachyon/secrets.env` does not define it
  - **When** an image, sound, or video plugin needs fal.ai auth
  - **Then** it returns the existing `unavailable` style error before any paid network call
- [x] The parser must not `source` or execute the secrets file; it only reads the `FAL_KEY` assignment and supports optional surrounding quotes.
- [x] The key must still never be printed, passed on argv, or inherited by child tools after it is copied into the non-exported auth variable.
- [x] Plugin docs/SKILL files explain `FAL_KEY` can come from the env or from `.tachyon/secrets.env`, and recommend creating `.tachyon/secrets.env` with restrictive permissions.

## Non-goals

- General dotenv support, variable expansion, multiline values, or plugin-specific secret stores.
- Changing cost-confirmation gates or adding any real paid dogfood call.

## Open questions

_Unresolved forks. Each with an owner or a path to resolution. Promote answered ones into acceptance scenarios._
