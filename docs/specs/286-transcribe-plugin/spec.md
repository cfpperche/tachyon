# 286 — transcribe-plugin

_Created 2026-06-28._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** shipped 2026-06-28 — the `transcribe` plugin is built in `tachyon-plugins/transcribe/` (manifest +
description-selectable SKILL + `transcribe.sh` + README), the first plugin consuming BOTH new engine capabilities: the
`ggml-base.bin` whisper model as a **spec-284 data artifact** (pinned to the IMMUTABLE HuggingFace revision
`ggerganov/whisper.cpp@5359861c739e955e79d9a303bcbc70fb988958b1`, real sha256
`60ed5bc3…2efe`, 148 MB < the 1 GiB cap), and `whisper-cli` + `ffmpeg` as **spec-285 external tools** (whisper-cli
assisted-install via `brew install whisper-cpp` only — apt/build manual; ffmpeg assisted on apt/dnf/pacman/brew). The
skill resolves model + binaries through the `_tachyon-data`/`_tachyon-external` shims, always transcodes input → 16 kHz
mono wav via ffmpeg, then runs whisper-cli (`--language auto`); fail-closed with distinct `unavailable` vs `failed`,
never an empty transcript. TWO codex duetos folded: DESIGN (NEEDS-REVISION → immutable model URL, whisper-cli not uvx,
ffmpeg required + always transcode, language auto) and IMPLEMENTATION (SHIP-WITH-CHANGES, no BLOCKER, whisper-cli flags
confirmed real → folded: a whisper-cli compatibility preflight; required flag values + single input; mktemp mapped to
fail-closed; validation order). **Verified (split acceptance, D7):** the manifest loads with 0 engine errors; the
script's arg/validation/fail-closed branches behave (bad/empty flags → 64, missing file → failed). **Dogfood honest
note:** a LIVE end-to-end transcription needs whisper-cli + ffmpeg + the 148 MB model installed — NOT runnable headless
on this WSL2 host (whisper-cli absent), and the install→resolve→fail-closed path is already proven by the engine's own
284/285 e2e tests. Committed in `tachyon-plugins` (`09039bf` + `6fb6d75`); the push + a `tachyon-plugins` release tag
are GATED on the owner. This CLOSES the migration loop that drove 284 + 285 (engine-first).

## Design decisions (folded from the 2026-06-28 codex design dueto — NEEDS-REVISION → all folded)

- **D1 — pin an IMMUTABLE model URL, never `resolve/main`** (BLOCKER): `resolve/main` is a moving branch ref →
  spec-284's fail-closed sha256 would deterministically break on any upstream move. Use
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/<full-commit>/ggml-base.bin` with the REAL sha256 of that exact
  URL (148 MB, MIT; fits the 1 GiB data cap). Record the revision + size + license in the README.
- **D2 — `whisper-cli` external tool; assisted install = `brew install whisper-cpp` ONLY** (BLOCKER + HIGH): brew's
  `whisper-cpp` formula installs `whisper-cli`; Debian sid's `whisper.cpp-tools` also ships `/usr/bin/whisper-cli`. The
  PyPI `whisper.cpp-cli` (uvx) exposes `whisper-cpp` (NOT `whisper-cli`) + is pinned to old v1.5.5 → REMOVED from the
  path. apt/dnf naming is distro-specific (per-PM, not per-distro in 285) → MANUAL guidance, not assisted.
- **D3 — `ffmpeg` required; ALWAYS transcode to temp 16 kHz mono PCM wav** (HIGH): whisper-cli needs 16-bit wav unless
  built with ffmpeg; avoid build-variance by always running `ffmpeg -nostdin -y -i <in> -ar 16000 -ac 1 -c:a
  pcm_s16le <tmp.wav>` → `whisper-cli`. ffmpeg's assisted install IS reliable across apt/dnf/brew/pacman.
- **D4 — exact fail-closed states** (HIGH): the skill distinguishes shim-missing / model-absent / whisper-missing /
  ffmpeg-missing / conversion-failed / whisper-nonzero — each `unavailable` or `failed`, NEVER an empty transcript;
  handles paths with spaces.
- **D5 — `--language auto`** (MEDIUM): whisper-cli defaults to English; the model is multilingual → default to auto.
- **D6 — formats** (MEDIUM): v1 = txt default + srt/vtt/json via whisper-cli's native `--output-*`; drop csv/lrc.
- **D7 — split acceptance** (MEDIUM): manifest-load + preview + shims-resolve are the universal gate; a REAL
  transcription dogfood is host-conditional (148 MB model + whisper + ffmpeg + CPU; the privileged assisted install is
  not headless-CI), recorded honestly.

## Intent

The first marketplace plugin to consume BOTH new engine capabilities together: **speech-to-text**. It is the
migration that surfaced specs 284 (data artifacts) + 285 (external-tool requirements) — now buildable on top of them.

A `transcribe` plugin (in the `tachyon-plugins` repo, like `dep-audit`) ships a description-selectable SKILL that turns
an audio/video file into a transcript, fully local: it needs (1) a `whisper.cpp` engine binary, (2) `ffmpeg` to decode
non-wav inputs, and (3) a pinned `ggml` model file. The plugin declares all three through the engine:

- the model (~140 MB) → a **spec-284 data artifact** (pinned `{url, sha256}` from a stable HTTPS host, installed
  read-only, resolved via `_tachyon-data`);
- `whisper-cli` + `ffmpeg` → **spec-285 external tools** (detected spoof-resistant; assisted-install offered;
  resolved via `_tachyon-external`).

"Done": installing the plugin surfaces the model (download+store ack) + the two external tools (present/missing +
assisted install); a description-matched skill, given an audio file, resolves the model + the two binaries through the
shims and produces a transcript — fail-closed with actionable guidance when a piece is missing. NO band-aids: the skill
NEVER curls the model itself and NEVER runs an unresolved binary (both engines enforce that).

## Acceptance criteria

- [ ] The plugin manifest (`tachyon-plugins/transcribe/tachyon-plugin.json`) declares a `data` model artifact + two
      `externalTools` (`whisper-cli`, `ffmpeg`), and loads with **0 engine errors** (`loadPlugin`).
- [ ] **Scenario: install surfaces all three dependencies**
  - **Given** the transcribe plugin
  - **When** it is previewed/installed
  - **Then** the consent shows the model (data, download+store ack) + whisper-cli/ffmpeg present/missing, and install
    provisions the model + materializes both `_tachyon-data` and `_tachyon-external` shims
- [ ] **Scenario: the skill resolves everything through the shims**
  - **Given** an installed plugin on a host with whisper-cli + ffmpeg present
  - **When** the skill transcribes an audio file
  - **Then** it resolves the model via `_tachyon-data` + the binaries via `_tachyon-external`, runs whisper-cli on the
    model, and writes the transcript — never curling the model, never running an unresolved binary
- [ ] **Scenario: fail-closed on a missing piece**
  - **Given** whisper-cli is not installed
  - **When** the skill runs
  - **Then** it reports `unavailable` naming the missing tool + how to get it (the assisted install / manual), never a
    fake/empty transcript
- [ ] the model artifact's `sha256` is the REAL digest of the pinned `ggml-base.bin` (verified by downloading it once at
      build time), not a placeholder
- [ ] a dogfood proves the end-to-end path on this host (or honestly records what couldn't run + why)

## Non-goals

- Changing the engine (284/285 are done; this is a pure CONSUMER plugin — if a gap appears, engine-first per the
  standing rule, but none is expected).
- Bundling whisper.cpp as a provisioned binary (it has no clean per-platform release binary → it is an external-tool
  CONTRACT, exactly what 285 is for).
- Multiple model sizes / model switching in v1 (pin ONE model — `base`, multilingual; a different model = a plugin
  update).
- A GUI; remote/paid transcription; speaker diarization; live transcription.

## Open questions

- **OQ1 — the whisper binary name + per-PM install.** Recent whisper.cpp ships `whisper-cli`; older `main`/`whisper`.
  Declare `whisper-cli` as the external tool. `brew install whisper-cpp` provides it on macOS; apt/dnf have NO
  whisper.cpp package → those platforms fall to the `manual` guidance (the `uvx --from whisper.cpp-cli` path the source
  tool used). Confirm the brew formula's installed binary name at build/dogfood time.
- **OQ2 — the model sha256.** Must be the real digest of
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin` — compute it once at build (download +
  sha256), pin it. (HuggingFace `resolve/main` is a moving ref → consider pinning a revision URL for reproducibility.)
- **OQ3 — wav-only vs ffmpeg.** whisper.cpp consumes 16 kHz wav; ffmpeg decodes everything else. Declare ffmpeg as a
  second external tool; the skill pipes non-wav through ffmpeg → whisper-cli. Confirm whether ffmpeg is strictly
  required (skip it for a wav-only v1?) — lean: declare it (most inputs aren't wav).
- **OQ4 — output formats.** The source tool emitted txt/srt/vtt/json/csv/lrc. v1 skill: txt by default + srt/vtt via a
  flag (whisper-cli's own `--output-*`). Keep it thin.
- **OQ5 — skill→shim invocation contract.** The skill resolves via the repo-root-relative shims
  (`.tachyon/bin/_tachyon-data <plugin> model`, `.tachyon/bin/_tachyon-external <plugin> whisper-cli|ffmpeg`), exactly
  the spec-272 launcher contract. Confirm the skill is runtime-agnostic (claude + codex).

## Context / references

- spec 284 (data artifacts) + spec 285 (external-tool requirements) — the two engine capabilities this consumes.
- spec 272 (dep-audit) — the prior plugin-in-`tachyon-plugins` build pattern (manifest + SKILL.md + README + the
  launcher-by-workspace-relative-path invocation contract).
- spec 275 (visual-qa-skill) — the description-selectable SKILL pattern.
- The migration thread: this plugin is why 284 + 285 were built (engine-first); it closes that loop.
