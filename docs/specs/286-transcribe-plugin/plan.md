# 286 — transcribe-plugin — plan

_Drafted from `spec.md` on 2026-06-28._

## Approach

Build the transcription capability as a first-party marketplace plugin in `tachyon-plugins/transcribe/`, not as a
Tachyon core feature. The plugin consumes the engine capabilities delivered immediately before it:

- spec 284 data artifacts for the pinned `ggml-base.bin` model;
- spec 285 external-tool requirements for `whisper-cli` and `ffmpeg`;
- a description-selectable skill plus a small shell script that resolves every dependency through Tachyon shims.

The runtime path is intentionally simple and fail-closed:

1. validate CLI args (`<audio-or-video-file>`, `--format`, `--language`);
2. resolve model via `.tachyon/bin/_tachyon-data transcribe model`;
3. resolve tools via `.tachyon/bin/_tachyon-external transcribe whisper-cli` and `ffmpeg`;
4. transcode input to private-temp 16 kHz mono PCM WAV with ffmpeg;
5. run `whisper-cli` against the pinned model and temp WAV;
6. print the transcript to stdout, never fabricating an empty transcript.

Acceptance is split: manifest/engine contracts and fail-closed script behavior can be proven headlessly; a real
end-to-end transcription is host-conditional because it requires the large model plus system `whisper-cli`/`ffmpeg`.

## Key decisions

- **Immutable model URL** — use a HuggingFace URL pinned to a full commit revision, not `resolve/main`, so the
  spec-284 sha256 contract does not break when upstream moves a branch.
- **`whisper-cli` as external tool** — do not provision or `uvx` it; distro packaging differs and the PyPI command
  shape does not match the needed binary. Assisted install is only reliable for Homebrew's `whisper-cpp`.
- **`ffmpeg` required** — always transcode through ffmpeg to avoid relying on how `whisper-cli` was compiled.
- **Native whisper output formats only** — support `txt`, `srt`, `vtt`, and `json`; reject unsupported formats early.
- **Honest dogfood boundary** — mark live transcription as conditional on host tools/model availability; prove the
  engine contracts through 284/285 and script failure modes instead of pretending CI can install privileged tools.

## Files touched

- `tachyon-plugins/transcribe/tachyon-plugin.json` — plugin manifest with data artifact + external tool declarations.
- `tachyon-plugins/transcribe/skills/transcribe/SKILL.md` — user-facing skill contract and invocation.
- `tachyon-plugins/transcribe/skills/transcribe/scripts/transcribe.sh` — fail-closed local transcription runner.
- `tachyon-plugins/transcribe/README.md` — dependency, install, privacy, and failure-mode docs.
- Tachyon repo `docs/specs/286-transcribe-plugin/*` — design record and closure evidence.

## Risks & unknowns

- Large model download makes live dogfood slow and host-dependent.
- `whisper-cli` flag compatibility varies across versions; script should preflight required flags and fail clearly.
- Assisted install for `whisper-cli` is not portable across Linux distributions, so manual guidance is necessary.
- Local CPU performance is outside Tachyon's guarantee.

## Sources consulted

- `docs/specs/284-plugin-data-artifacts/` — data artifact declaration, resolver, lockfile, and consent model.
- `docs/specs/285-external-tool-requirements/` — external tool detection, resolver, and assisted install model.
- `docs/specs/287-plugin-install-ux/` — dogfood follow-ups from installing transcribe.
- The `tachyon-plugins` plugin layout used by existing marketplace plugins.
