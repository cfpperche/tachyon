# 286 — transcribe-plugin — tasks

_Generated from `plan.md` on 2026-06-28._

## Implementation

- [x] Design review with Codex; fold immutable model URL, tool-shape, ffmpeg, language, and format decisions.
- [x] Add `tachyon-plugins/transcribe/tachyon-plugin.json` with a spec-284 data artifact for `ggml-base.bin`.
- [x] Declare `whisper-cli` and `ffmpeg` as spec-285 external tools with honest assisted/manual install guidance.
- [x] Add `SKILL.md` for description-selectable local speech-to-text.
- [x] Add `transcribe.sh` that resolves model/tools only through `_tachyon-data` and `_tachyon-external`.
- [x] Always transcode input with ffmpeg to 16 kHz mono PCM WAV in a private temp dir.
- [x] Support `txt`, `srt`, `vtt`, and `json`; reject bad args/format/language combinations.
- [x] Distinguish `unavailable` dependency gaps from `failed` decode/whisper failures.
- [x] Add README docs for local-only privacy, dependencies, install behavior, and host-conditional dogfood.
- [x] Implementation review with Codex; fold compatibility preflight, flag validation, `mktemp` failure handling, and
      validation-order findings.

## Verification

- [x] Plugin manifest loads with 0 engine errors.
- [x] Manifest declares one data artifact and two external tools.
- [x] Script validates bad/empty flags with exit 64.
- [x] Missing input file fails closed as `failed`.
- [x] Script never curls/downloads the model itself.
- [x] Script resolves model and binaries through Tachyon shims.
- [x] Live transcription dogfood recorded as host-conditional because this WSL2 host lacked `whisper-cli`.

**Headless check:** manifest load + script validation/fail-closed branches.

**Human approval:** optional live transcription after installing `whisper-cli`, `ffmpeg`, and the 148 MB model through
the Tachyon plugin install flow.

## Closure evidence

- Design Codex dueto: NEEDS-REVISION, all findings folded.
- Implementation Codex dueto: SHIP-WITH-CHANGES, all findings folded.
- Manifest-load and script failure-path checks passed.
- `tachyon-plugins` commits: `09039bf` + `6fb6d75`.
