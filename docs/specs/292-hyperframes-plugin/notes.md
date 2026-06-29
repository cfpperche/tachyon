# 292 — hyperframes-plugin — notes

_Created 2026-06-29._

## Implementation (2026-06-29)

The deterministic/free half of the split video capability, in `tachyon-plugins/hyperframes/`. HTML composition → MP4
via `npx hyperframes@0.7.18` (HeyGen, Apache-2.0) + system ffmpeg; HyperFrames manages its own headless Chromium.

- **manifest = ffmpeg ONLY** (Chrome is hyperframes-managed — verified in the engine code by the design dueto).
- **npx** = ambient runner; **Node ≥22** verified (not just `npx`).
- ships our **OWN minimal template** (`references/composition-template/`, rebranded, zero Agent0 refs) + `scaffold`/
  `render`/`doctor`; **NEVER runs `hyperframes init`** (it couples to upstream scaffolding + remote/global-skills pulls).
- official HeyGen skill = **inspiration, NOT vendored** (`CREDITS.md` attributes Apache-2.0; `references/authoring.md`
  points to HeyGen's skills for deep authoring).
- ffmpeg resolved TRUSTED via `_tachyon-external` + put first on PATH for render; output contained, temp+`mv -f`
  (no symlink follow), never `git add`s, git-ignore advisory.

## Design dueto (SHIP-WITH-CHANGES) — folded (D0–D6 in spec.md)

Codex read the actual hyperframes code in the npx cache. Confirmed: Chrome internal (Puppeteer bundled Chromium +
download cache + system fallback) → manifest ffmpeg-only; render does NOT need init's global skills; same npx
lower-trust lane as diagram; Node ≥22 required; Linux-ARM `ensureBrowser()` has an apt-get path → fail closed.

## Impl dueto (NEEDS-REVISION) — all folded (commit 916666e)

- **HIGH** — the ARM no-apt guard false-passed on a nonempty cache dir (stale/unrelated/Playwright) → render could
  still reach upstream's `apt-get install`. Fix: on Linux ARM accept ONLY an executable system browser
  (google-chrome/chromium/…) or an executable `HYPERFRAMES_BROWSER_PATH`; dropped the cache-dir proxies.
- **MEDIUM** — the ffmpeg PATH-prepend could hijack `npx`. Fix: resolve `NPX` to an absolute path BEFORE editing PATH;
  invoke `"$NPX"`; export `HYPERFRAMES_FFMPEG_PATH`; validate ffmpeg executable.
- **MEDIUM** — render `cd`'d into the composition dir without containment. Fix: realpath-contain `COMP_DIR` under
  `<root>/assets/video/compositions/` before cd.
- **LOW** — scaffold created the slug dir before the realpath check. Fix: realpath-check the compositions parent first.
- Dueto confirmed: no `hyperframes init` in shipped code; `-o` is a valid render alias; slug/quality quoting sound;
  empty MP4 rejected before `mv`; Apache attribution present; no Agent0/private-path leakage; SKILL frontmatter safe.

## Verification (real engine, NO new engine)

- HEAVY render proof: scaffold + render (owned template, NO init, ffmpeg override) → valid 172 KB MP4.
- Headless install dogfood: install via the engine → lockfile ffmpeg + shim + skill → `_tachyon-external hyperframes
  ffmpeg` = /usr/bin/ffmpeg (trusted; host ~/bin ffmpeg correctly NOT used) → scaffold + render via the INSTALLED
  payload (real shim ffmpeg, no override) → valid 172 KB MP4. Manifest loads 0 errors.

## Caveats / remaining

- The shipped template loads GSAP via CDN (network at render; documented). First render downloads a Chromium into
  HyperFrames' own cache (the npx lower-trust lane). hyperframes is pre-1.0 (0.7.18) — pin exact; a refresh routine
  later. NOT pushed/tagged — ready for `tachyon-plugins` v0.20.0 on the owner's nod; no extension bump needed.
- NEXT (the split's other half): the `video` plugin = paid generative fal.ai (async submit→poll + ledger + cost gate)
  — the image/sound API-plugin shape extended to async. Separate spec when the owner is ready.
