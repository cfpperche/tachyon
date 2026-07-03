# 337 — fal-key-secrets-env — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add a non-executing `.tachyon/secrets.env` `FAL_KEY` parser to the image script.
- [x] Add the same fallback to the sound script.
- [x] Add the same fallback to the video script for both paid submit and authenticated poll paths.
- [x] Update image/sound/video README and SKILL docs.
- [x] Bump image/sound/video plugin manifest patch versions.
- [x] Mark the spec accepted/shipped after verification.

## Verification

- [x] `bash -n` passes for the three changed scripts.
- [x] With `FAL_KEY` absent and `.tachyon/secrets.env` absent, each plugin still fails before any paid call.
- [x] With `FAL_KEY` absent and `.tachyon/secrets.env` present, mocked image generation reaches the existing auth path without a real fal call.
- [x] With `FAL_KEY` in the environment and a different `.tachyon/secrets.env`, the environment value wins.
- [x] Static scan confirms the scripts do not `source` or `eval` the secrets file.

**Verify:** `bash -n /home/goat/tachyon-plugins/image/skills/image/scripts/image.sh /home/goat/tachyon-plugins/sound/skills/sound/scripts/sound.sh /home/goat/tachyon-plugins/video/skills/video/scripts/video.sh && ! rg -n '(^|[[:space:]])(source|eval)[[:space:]]+.*secrets\\.env|(^|[[:space:]])\\.[[:space:]]+.*secrets\\.env' /home/goat/tachyon-plugins/image/skills/image/scripts/image.sh /home/goat/tachyon-plugins/sound/skills/sound/scripts/sound.sh /home/goat/tachyon-plugins/video/skills/video/scripts/video.sh`

## Dogfood

**Dogfood:** `bash /home/goat/tachyon-plugins/scripts/dogfood-fal-secrets-env.sh`

**Human dogfood:** optional: create `.tachyon/secrets.env` with `FAL_KEY=<key>`, run a paid plugin only if you explicitly want to spend money, and confirm the plugin does not require a shell export.

## Visual QA

**Visual QA Opt-Out:** backend/script/docs-only change; no rendered UI surface changes.
