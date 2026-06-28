# 289 — external-tool-aliases

_Created 2026-06-28._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

The external-tool engine (spec 285) resolves a requirement by a SINGLE binary name (`whisper-cli`, `ffmpeg`).
That breaks for tools whose binary name varies per host — most acutely a **browser**: Chrome ships as
`google-chrome` / `google-chrome-stable` on one machine, `chromium` / `chromium-browser` on another, and they are
NOT interchangeable. Surfaced building the `diagram` plugin (spec 288), which needs a headless system Chrome:
on the dogfood host there is `google-chrome` but no `chromium` (and Ubuntu has no apt `chromium` — it's a snap),
so a single-name declaration mis-detects a present browser as "missing".

Add an OPTIONAL, ordered list of candidate binary names to an external-tool declaration. Detection/resolution tries
each candidate on the clean PATH and returns the **first TRUSTED** one — same spoof-resistant trust check as today,
just over N candidates instead of one. Fully back-compatible: a declaration without the list behaves exactly as now
(single name = the manifest key). This is a small, GENERAL engine enhancement (any multi-alias tool benefits), not a
diagram-specific hack — and it keeps the diagram plugin honest (no PATH-scan workaround bypassing trusted resolution).

## Design decisions (folded from the 2026-06-28 codex design dueto — SHIP-WITH-CHANGES → all folded)

Security bottom line (dueto): N-candidate resolution does NOT weaken spec 285's PATH anti-spoof guarantee as long as
every candidate is resolved on the clean PATH and individually passes `isTrustedExecPath`. The corrections are about
detect-correctness, auditability, and avoiding the two resolution paths diverging.

- **D1 — field shape.** `ExternalToolDecl` gains optional `names?: string[]` — the ORDERED, COMPLETE candidate binary
  set (OQ1: `names`, not `aliases`). When omitted, resolution uses `[<manifest key>]` (exact current behavior). When
  present, ONLY the listed names are tried — the key is NOT auto-included (OQ2: a display-only key like `chrome` that
  is not a real binary must not pollute resolution; if the key IS a real binary, list it explicitly). The manifest
  KEY stays the canonical identity (`_tachyon-external <plugin> <key>`, the card label, the lockfile req key).
- **D2 — resolution = first candidate that is TRUSTED *and whose `detect` passes* (codex HIGH).** For each candidate
  in order: resolve on the clean PATH (spawn or spawn-free), `isTrustedExecPath`; if trusted AND (no `detect` OR the
  `detect` probe passes against THAT binary) → win. A candidate that is untrusted OR detect-failing does NOT stop the
  search (try the next). `missing`/`unavailable` only after ALL candidates are absent/untrusted/detect-failed. Without
  `detect`, trusted is sufficient. (Skipping rather than hard-failing on an untrusted first match is deliberate —
  hard-fail would let an attacker DoS the tool by planting an untrusted earlier alias; we never execute/return it.)
- **D3 — persist the candidates in the lockfile.** `ExternalToolReqLock` gains `names?: string[]` so the runtime
  `_tachyon-external` resolver (reads the lockfile, not the manifest) tries the same set. Additive + back-compat (an
  older lock without it = single-name by the key).
- **D4 — install/assisted-install UNCHANGED.** `names` is purely DETECTION/resolution; the per-PM install argv map is
  orthogonal (targets a package, not a binary name). buildAssistedInstall/validateInstallArgv untouched. Post-install
  re-detection (terminal-close, spec 287) re-runs the SAME `names` set from the lock — already covered by D3.
- **D5 — validation (codex LOW).** A DEDICATED exec-name regex (NOT the plugin-key regex): `^[A-Za-z0-9][A-Za-z0-9._-]*$`
  (letters/digits/dot/underscore/hyphen; no path separator, no control chars — covers `chromium-browser`,
  `google-chrome-stable`, future `python3.11`/`foo.exe`). Cap at **8** candidates; dedupe preserving order; reject an
  invalid entry fail-closed (manifest parse error); `[]` treated EXACTLY as omitted (use the key).
- **D6 — auditability (codex MEDIUM): the candidate set is security-relevant, not invisible metadata.** A manifest
  could label the key `chrome` while listing unrelated trusted binaries — not PATH spoofing, but consent/audit
  confusion. So: (a) persist `names` in the lock (D3); (b) SURFACE the candidate `names` + the winning resolved path
  in the consent drawer's external-tools row + the installed-card detail (the user sees which host binaries satisfy
  the requirement). NOT added to the install fingerprint — external-tool requirements are deliberately NOT part of
  `fingerprintOf` (they are informational, never gate the install, spec 285/287); adding them would change the gate
  semantics. Auditability is via disclosure, not the TOCTOU fingerprint.
- **D7 — one shared candidate helper (codex MEDIUM): no path divergence.** A single `candidateNames(key, names?)`
  feeds BOTH the spawn path (`detectExternalTool` / `resolveExternalTool`) AND the spawn-free card path
  (`detectExternalToolPresence`, spec 287). The card presence check receives the full lock req (with `names`), not
  just the key — so preview/runtime and the card never disagree on which alias is present.

## Acceptance criteria

- [ ] **Scenario: first trusted candidate wins**
  - **Given** an external tool declares `names: ["google-chrome", "chromium"]` and only `chromium` is present+trusted
  - **When** detection/resolution runs
  - **Then** it resolves `chromium` (present), and a host with only `google-chrome` resolves that instead
- [ ] **Scenario: untrusted candidate is skipped, not accepted**
  - **Given** the first candidate resolves to an untrusted path (user-writable dir) and the second is trusted
  - **When** resolution runs
  - **Then** it skips the untrusted first and returns the trusted second (never returns an untrusted match)
- [ ] **Scenario: trusted-but-detect-failing candidate falls through (codex HIGH)**
  - **Given** candidate A is trusted but its `detect` probe fails, and candidate B is trusted + detect-passing
  - **When** resolution runs
  - **Then** it skips A and returns B (resolution = first trusted AND detect-passing)
- [ ] **Scenario: back-compat (no names)**
  - **Given** an external tool with NO `names` (today's shape)
  - **When** detection runs
  - **Then** it behaves exactly as before (resolves the manifest key)
- [ ] **Scenario: spawn + spawn-free agree (codex MEDIUM)**
  - **Given** only alias B is present+trusted
  - **When** the install preview/runtime resolves AND the installed card computes presence
  - **Then** BOTH report present (a shared `candidateNames` helper; the card gets the full req incl. `names`)
- [ ] the candidate set is persisted in `ExternalToolReqLock.names` and the runtime `_tachyon-external` resolver tries
      the same set (lockfile-anchored, not manifest)
- [ ] the consent drawer + installed card SURFACE the candidate `names` + the winning resolved path (D6 disclosure)
- [ ] install/assisted-install behavior is unchanged; `names` validated by the dedicated exec-name regex, capped at 8,
      deduped order-preserving, `[]` == omitted, invalid entry → parse error (fail-closed)
- [ ] manifest + lockfile parse round-trip with 0 errors; existing 285/287 tests stay green

## Non-goals

- Making the `install` map optional / manual-only external tools (separate concern; Chrome can declare chromium PMs +
  manual fallback for now).
- Per-candidate distinct install commands (the install map stays keyed by PM, not by binary alias).
- Auto-discovering aliases (the plugin author lists them explicitly).
- Changing the trust model (same `isTrustedExecPath`; just applied over N candidates).

## Open questions

_All resolved by the 2026-06-28 design dueto — see § Design decisions._

- **OQ1 — `names` vs `aliases`.** RESOLVED → `names` (the complete ordered candidate set, not "extras").
- **OQ2 — auto-include the key?** RESOLVED → NO; only the listed `names` when present (key alone when omitted).
- **OQ3 — cap.** RESOLVED → cap 8, dedupe order-preserving, dedicated exec-name regex + length cap, fail-closed.

## Context / references

- spec 285 (external-tool requirements) — `detectExternalTool` / `resolveExternalTool` / `detectPackageManager`,
  the single-name model this generalizes; `ExternalToolReqLock`.
- spec 287 (plugin-install-ux) — `detectExternalToolPresence` (spawn-free card check) must honour `names` too.
- spec 288 (diagram-plugin) — the consumer: Chrome declared with `names: [google-chrome, google-chrome-stable,
  chromium, chromium-browser]`.
