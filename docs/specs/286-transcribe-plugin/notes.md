# 286 — transcribe-plugin — notes

_Created 2026-06-28._

## Design decisions

- **Immutable model pin** — the model URL uses a full HuggingFace commit revision for
  `ggerganov/whisper.cpp` and the real sha256 of `ggml-base.bin`; `resolve/main` was rejected because it is mutable
  and would turn a correct spec-284 data artifact into a future hash mismatch.
- **External `whisper-cli`** — `whisper-cli` is an external tool requirement, not a provisioned Tachyon binary and not
  a `uvx` path. The PyPI command shape and version did not match the needed binary; Linux distro packaging is too
  varied for a universal assisted install.
- **Required `ffmpeg`** — every input is converted through ffmpeg to a known WAV shape before calling whisper. This
  avoids relying on optional ffmpeg support inside a particular whisper.cpp build.
- **Default multilingual behavior** — `--language auto` is the default because whisper-cli otherwise tends toward
  English defaults while the selected model is multilingual.
- **Narrow output formats** — v1 supports only `txt`, `srt`, `vtt`, and `json`, matching native whisper-cli outputs.

## Deviations

- A live end-to-end transcription was not required as a universal headless gate. The host must have `whisper-cli`,
  `ffmpeg`, and the 148 MB model installed; this WSL2 host lacked `whisper-cli`. The spec records this honestly and
  relies on engine e2e coverage for the data/external-tool install contracts plus script fail-closed checks.

## Tradeoffs

- Assisted install for `whisper-cli` is reliable for Homebrew but not for apt/dnf/pacman in a cross-distro way, so the
  plugin prefers manual Linux guidance over a misleading one-size-fits-all package manager command.
- Always transcoding adds an ffmpeg dependency even for WAV inputs, but it gives one deterministic input shape to
  whisper-cli and avoids build-variant behavior.

## Reviews

- **Design Codex dueto** — NEEDS-REVISION. Folded: immutable model URL, external `whisper-cli` instead of uvx,
  required ffmpeg transcoding, default language auto, and reduced output formats.
- **Implementation Codex dueto** — SHIP-WITH-CHANGES. Folded: whisper-cli compatibility preflight, required flag
  values + single input enforcement, `mktemp` failure mapped to fail-closed behavior, and validation-order cleanup.

## Validation

- Manifest loads with 0 engine errors.
- Script argument and validation branches pass: bad/empty flags exit 64; missing file fails closed.
- Runtime dependency gaps produce `unavailable`; decode/whisper failures produce `failed`.
- No direct model download or bare PATH binary execution exists in the skill path; dependencies resolve through
  `_tachyon-data` and `_tachyon-external`.

## Open questions

- None for v1. Live transcription remains an environment-dependent smoke after the user installs the external tools
  and model.
