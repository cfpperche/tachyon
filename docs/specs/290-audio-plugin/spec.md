# 290 — audio-plugin

_Created 2026-06-29._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Design decisions (folded from the 2026-06-29 codex design dueto — SHIP-WITH-CHANGES → all folded)

- **D0 — NO new engine.** All deps map onto existing models: `uvx`/`espeak-ng`/`ffmpeg` = external tools (285);
  default piper voice = data artifacts (284); PyPI packages = an explicit lower-trust pinned-`uvx` lane mirroring
  diagram's pinned-`npx` lane (288). A new engine is needed ONLY if we insisted on manual-only external tools (we
  don't — see D1).
- **D1 — OQ1: `uvx` is a declared external tool (285), NOT npx-style assumed.** uv is NOT Tachyon-native (node is).
  Tachyon's schema requires `externalTools.*.install` ≥1 PM, so declare `uvx` with `brew install uv` (the one true
  assisted lane) + manual guidance for the official Linux installer (`curl|sh`) — the transcribe/whisper-cli pattern.
  `espeak-ng` = external tool (apt/dnf/pacman/brew). `ffmpeg` = external tool (proven). All resolved via
  `_tachyon-external`; surfaced on the drawer/card (287); use 289 `names` only if a tool truly has aliases.
- **D2 — OQ5: `piper` is the DEFAULT engine** (Tachyon provisions/checksums it most honestly: a clean pinned .onnx
  voice, no espeak-ng). `kokoro` stays the quality/multilingual opt-in (`--engine kokoro`), dragging espeak-ng + the
  shipped python helper + package-managed weights. Piper is the "always works" path for `wav`; `mp3` still needs ffmpeg.
- **D3 — OQ3: default voice = TWO 284 data artifacts** (`en_US-lessac-medium.onnx` + `.onnx.json`), each pinned to an
  IMMUTABLE HF revision + sha256 (NOT `resolve/main` — the transcribe blocker). Because Tachyon stores data by content
  hash (the two files are NOT on-disk siblings), the script COPIES both resolved files into a private temp dir with
  the sibling names piper expects (`<voice>.onnx` + `<voice>.onnx.json`) before invoking piper. Kokoro's weights stay
  package-managed (no 284). Other (non-default) piper voices are an on-demand, UNPINNED HF fetch (the lower-trust lane).
- **D4 — HIGH security: strict `--voice` sanitization.** Do NOT port Agent0's raw voice-name → path/URL construction.
  Allowlist the voice token (`^[A-Za-z0-9_-]+$`, bounded) BEFORE building any cache path or HF URL — no traversal.
- **D5 — pin every direct `uvx` package EXACTLY** (`piper-tts==X`, `kokoro==X`, `soundfile==X`); record
  `acquisition:"uvx"` + `engine_checksummed:false` in provenance. Disclose first-run network + offline behavior
  SEPARATELY for: the pinned default piper voice (offline after install), other piper voices (on-demand network),
  PyPI packages (uvx cache after first run), kokoro weights (package-managed first-run network).

## Intent

Migrate the `audio` capability — **local-first text-to-speech** — into a Tachyon plugin (third local tool-plugin
after transcribe + diagram). **LOCAL-ONLY by owner decision:** the two on-device engines (kokoro default; piper
alternative); the paid ElevenLabs `--remote` lane is DROPPED here and becomes a future separate **Tachyon + ElevenLabs
integration plugin** (an API-plugin: env-key, no binary — the image/sound shape). Text → spoken `wav`/`mp3`,
on-device; only model weights/voices are fetched once.

A `description`-selectable skill wraps `scripts/audio.sh` (a port of the Agent0 tool with the paid lane removed) +
ships the kokoro Python helper `audio-kokoro.py`. Fail-closed: `unavailable` (a dependency missing) vs `error` (a
present engine failed); never an empty/fake audio file.

### Dependency shape (the engine-first crux)

The two local engines both run through **`uvx`** (uv's tool runner — the Python analog of `npx`):

- **piper**: `uvx --from piper-tts piper` (acquires piper-tts) + a **voice model** (`<voice>.onnx` + `.onnx.json`, HF
  rhasspy/piper-voices, e.g. `en_US-lessac-medium`) + **ffmpeg** (mp3; wav needs none).
- **kokoro**: `uvx --with kokoro --with soundfile python audio-kokoro.py` + **`espeak-ng`** (system phonemizer) +
  **ffmpeg**; the kokoro ONNX weights are fetched by the package on first run.

Mapping onto existing engines (the hoped-for "no new engine" outcome):

| Dependency | Existing engine | Note |
|---|---|---|
| `uvx` (uv) runner | external-tool (285) **or** assumed→unavailable | uv is NOT Tachyon-native (node is); the npx-analog crux — OQ1 |
| piper-tts / kokoro (PyPI) | pinned-`uvx` lane | the diagram-D1 honest lower-trust lane (exact version, non-engine-checksummed) |
| `espeak-ng` | external-tool (285) | assist-install apt/brew |
| `ffmpeg` | external-tool (285) | proven in transcribe; wav works without |
| default piper voice `.onnx`+`.json` | data artifact (284) | pin ONE default (2 files); other voices on-demand (unpinned) — OQ3 |
| kokoro ONNX weights | package-managed | fetched by `uvx --with kokoro` first run (like an npx package's own deps) |

## Acceptance criteria

- [ ] **Scenario: local TTS (piper) → audio file**
  - **Given** the plugin installed + uvx present + the default piper voice resolvable
  - **When** `audio.sh "hello" --engine piper --format wav`
  - **Then** it writes a non-empty wav (and mp3 when ffmpeg is present), `status=ok`, stayed-local
- [ ] **Scenario: local TTS (kokoro) → audio file**
  - **Given** uvx + espeak-ng present
  - **When** `audio.sh "olá" --engine kokoro --lang pt`
  - **Then** it synthesizes via the kokoro helper, `status=ok`
- [ ] **Scenario: graceful degradation**
  - **Given** uvx absent → `unavailable` (install uv); kokoro w/o espeak-ng → `unavailable` (distinct hint, suggest piper)
  - **Then** never a crash, never an empty file
- [ ] the paid/`--remote`/ElevenLabs lane + FAL_KEY + tiers are GONE from this plugin (local-only)
- [ ] external tools (uvx?/espeak-ng/ffmpeg) surface on the install drawer + card per spec 285/287/289
- [ ] uvx-acquired engines are pinned to exact versions; first-run network disclosed; provenance records the lane
- [ ] the default piper voice is provisioned as a pinned data artifact (offline/checksummed); other voices on-demand
- [ ] self-contained in `tachyon-plugins/audio/` (manifest + skill + audio.sh + audio-kokoro.py + README); zero Agent0 refs
- [ ] NO new engine capability (D0 — reuses 284/285/289 + the uvx lane)
- [ ] **`--voice` is allowlisted (`^[A-Za-z0-9_-]+$`, bounded) before ANY path/URL construction** (D4 — no traversal)
- [ ] the default piper voice is pinned to an IMMUTABLE HF revision + sha256 (both .onnx + .onnx.json); the script
      copies both resolved data files into a temp dir as siblings before invoking piper (D3)
- [ ] every direct `uvx` package is pinned exactly; provenance records `acquisition:"uvx"` + `engine_checksummed:false` (D5)

## Non-goals

- The paid/remote lane (ElevenLabs/fal) — a future separate integration plugin.
- Music/SFX (that's the `sound` capability) and voice cloning.
- Pinning the entire 900+ piper voice catalog (pin one default; others on-demand).
- A new python-package provisioning engine unless the dueto proves the uvx lane is insufficient.

## Open questions

_All resolved by the 2026-06-29 design dueto — see § Design decisions._

- **OQ1 — uvx handling.** RESOLVED → D1: declared external tool (285), brew-assisted + manual; not npx-style.
- **OQ3 — voice model.** RESOLVED → D3: 2 pinned 284 data artifacts (immutable HF rev) + script copies them as
  siblings; other voices on-demand unpinned; kokoro weights package-managed.
- **OQ5 — default engine.** RESOLVED → D2: piper default, kokoro opt-in.
- (new) **OQ6 — uvx exact-version pin syntax.** Confirm at build time that `uvx --from piper-tts==X piper` and
  `uvx --with kokoro==X --with soundfile==X python helper.py` are accepted by the installed uv (verified during the
  build dogfood).

## Context / references

- spec 286 (transcribe) — sibling local tool-plugin (data + external tools); the shape to mirror.
- spec 288 (diagram) — the npx-lane precedent (D1: pinned runner, honest non-checksummed acquisition) that uvx mirrors.
- spec 284 (data artifacts) — the default voice model; spec 285 (external tools) — espeak-ng/ffmpeg/uvx; spec 289
  (candidate names) — if any tool needs aliases; spec 287 (install-UX) — the card/drawer surfacing.
- The source capability: the Agent0 `audio` skill + `audio.sh` + `audio-kokoro.py` (kokoro/piper local lanes, the
  paid lane to be dropped) — the behavioural contract to preserve (minus paid).
