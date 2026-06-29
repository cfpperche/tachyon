# 290 — audio-plugin — notes

_Created 2026-06-29._

## Implementation (2026-06-29)

Third local tool-plugin, in `tachyon-plugins/audio/`. LOCAL-ONLY (no paid/remote lane). Built parallel-safe (separate
repo from the extension). Two engines via `uvx` at pinned versions: **piper** (default; `uvx --from piper-tts==1.4.2`)
+ **kokoro** (`--engine kokoro`; `uvx --with kokoro==0.9.4 --with soundfile==0.14.0 python audio-kokoro.py`, needs
espeak-ng). Default piper voice = two pinned 284 data artifacts (`en_US-lessac-medium.onnx` + `.onnx.json`, immutable
HF rev `e21c7de8…` + sha256), copied to sibling names before piper; other voices on-demand (unpinned, allowlisted).

## Design dueto (SHIP-WITH-CHANGES) folded — D0–D5 in spec.md

NO new engine. uvx/espeak-ng/ffmpeg + default voice all map onto existing models. Piper = default (most honestly
provisionable); kokoro = quality opt-in. Strict `--voice` allowlist; uvx packages pinned exactly.

## Build deviation (judged defensible by the impl dueto)

The design dueto said "declare `uvx` as a 285 external tool". A build check found uv installs to `~/.local/bin`
(`/home/goat/.local/bin/uvx`) — a USER dir the external-tool clean-system-PATH trust model REJECTS. Gating uvx there
would make the plugin `unavailable` for essentially every uv user, and it contradicts the diagram precedent (the
runner npx is ambient; only the heavy system dep is trust-gated). So **uvx = ambient `command -v` runner** (override
`AUDIO_UVX`), missing → `unavailable`; only espeak-ng + ffmpeg are external tools. The impl dueto agreed this is
defensible (a future "trusted user-tool lane" in the engine is the optional middle, not built).

## Impl codex dueto (NEEDS-REVISION) — all folded (commit b2b832c)

uvx-ambient deviation OK. Findings:
- **HIGH** — symlink output-containment bypass: `cp`/ffmpeg wrote directly to `$OUTPUT`; a pre-existing symlink there
  would be followed. Fix: produce into a fresh `mktemp` inside the out dir, then `mv -f --` over the final path
  (replaces a symlink, never follows); `-f mp3` for the ffmpeg temp.
- **HIGH** — kokoro's phonemizer wasn't bound to the trusted espeak-ng. Fix: run uvx with a sanitized
  `PATH=dirname(ESPEAK):<system dirs>` (trusted espeak first, never cwd/workspace).
- **MEDIUM** — failed mp3 left a stale file (fixed by temp+mv); pinned-voice `cp` unguarded under `set -e` (fixed →
  explicit `unavailable` on unreadable data).
- **LOW** — docs/spec wording said uvx was an external tool (corrected to ambient runner).
- Dueto crux checks PASSED: no shell injection (`$TEXT`/`$LANG`/`$VOICE` argv-safe); `--voice` allowlist blocks
  traversal in both the HF URL + the sibling copy; piper sibling-config discovery correct; pins exact.

## Headless dogfood — full pass (real engine)

install → lockfile records 2 data + 2 externals → shims + skill materialized → `_tachyon-data audio voice-onnx`
resolves the content-addressed pinned blob (`5efe09e6…`) → piper renders the PINNED voice via the shims → valid
132 KB wav. Separately: piper wav + mp3 (valid MPEG, via temp+mv `-f mp3`) verified directly. (kokoro live run not
exercised — needs espeak-ng + the package's first-run weights; the code path + PATH-binding are folded.)

## Remaining

NOT pushed/tagged — ready for `tachyon-plugins` v0.18.0 + (extension already carries the engines it needs at 0.53.2;
no extension bump needed for audio) on the owner's nod. ElevenLabs deferred to a future separate integration plugin.
