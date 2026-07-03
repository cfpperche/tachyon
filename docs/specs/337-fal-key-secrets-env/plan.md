# 337 — fal-key-secrets-env — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Update the source plugins in `/home/goat/tachyon-plugins` for `image`, `sound`, and `video`.

Each script gets the same local helper:

- if `FAL_KEY` is already set, leave it alone;
- otherwise look for `$ROOT/.tachyon/secrets.env`;
- parse only a `FAL_KEY=...` or `export FAL_KEY=...` assignment, without `source`/`eval`;
- continue through the existing copy-to-`_FAL` + `unset FAL_KEY` flow.

Docs and SKILL files should describe the supported file and its security posture. The plugin manifests should bump
their patch versions because marketplace consumers need a visible changed artifact.

## Key Decisions

- **Use `.tachyon/secrets.env` rather than root `.env`** — chosen because `.tachyon/` is already gitignored in Tachyon workspaces; rejected root `.env` because this repo does not currently ignore it and accidental commits would be easy.
- **Environment wins over file fallback** — chosen so CI, one-off shells, and agent-local overrides can supersede the workspace default without editing files.
- **Parse, do not source** — chosen because a secrets file is data, not trusted shell code.

## Files Touched

- `/home/goat/tachyon-plugins/image/skills/image/scripts/image.sh` — load fallback key before existing auth copy/unset.
- `/home/goat/tachyon-plugins/sound/skills/sound/scripts/sound.sh` — same.
- `/home/goat/tachyon-plugins/video/skills/video/scripts/video.sh` — same for `submit` and `poll`.
- `/home/goat/tachyon-plugins/{image,sound,video}/README.md` — document `.tachyon/secrets.env`.
- `/home/goat/tachyon-plugins/{image,sound,video}/skills/*/SKILL.md` — update agent-facing instructions.
- `/home/goat/tachyon-plugins/{image,sound,video}/tachyon-plugin.json` — patch version/description.
- `docs/specs/337-fal-key-secrets-env/*` — spec record and verification evidence.

## Risks & Unknowns

- A naive dotenv implementation could execute arbitrary shell. Verify the scripts do not use `source` or `eval`.
- The helper must not move key loading before `ROOT` is resolved, because the fallback path is workspace-relative.
- Tests must avoid real paid fal.ai calls; use mocked `curl`/`jq` or stop before network.

## Visual Impact

No UI surface changes. Documentation text changes only.

## Sources Consulted

- `/home/goat/tachyon-plugins/image/skills/image/scripts/image.sh`
- `/home/goat/tachyon-plugins/sound/skills/sound/scripts/sound.sh`
- `/home/goat/tachyon-plugins/video/skills/video/scripts/video.sh`
- `.gitignore` in Tachyon confirms `.tachyon/` is local-only.
- Project handoff "API-plugin secret discipline" confirms existing FAL_KEY/curl-config security posture.
