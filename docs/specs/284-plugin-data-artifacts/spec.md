# 284 — plugin-data-artifacts

_Created 2026-06-28._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** shipped 2026-06-28 — data-artifact provisioning lands end-to-end (the non-executable sibling of the
spec-265 tool path). Lanes A (manifest DataDecl + parseData; `dataPlan`; `installData` streamed/0o400/no-smoke,
`MAX_DATA_ARTIFACT_BYTES`=1 GiB), B (`DataLock` + sha-only `physicalDataKey` + refcount; `resolveDataForAccess`
fd-enforced + the `_tachyon-data` shim/bundle), C (engine install/remove/update wiring; `ConsentData` +
`requiresDataConfirm`; PluginsPanel + drawer ack; rehydrate). A skill resolves a blob via
`.tachyon/bin/_tachyon-data <plugin> <name>`. Two codex duetos folded: the DESIGN dueto (D1–D7, pre-build) and the
IMPLEMENTATION dueto (NEEDS-REVISION → all 6 folded: BLOCKER sha-only refcount; HIGH launcher-block merge,
clone-rehydrate shim restore, finalUrl-parity-with-265; MEDIUM reuse-invariant revalidation, reselect dataPlan).
~45 unit tests incl. regressions for each folded finding. Verified: full suite 1775 green, typecheck + build clean.
Commits f2dd59f→(this). Consumer: a transcription plugin (whisper `ggml` model) once spec 285 lands the binary side.

## Intent

The plugin tool-provisioning engine (spec 265) can fetch only **executables**: download → verify sha256 → (archive
extract) → smoke-check by EXECUTING it (`--version`) → install **mode `0o500` (exec-only)** → the launcher re-validates
the hash before **every exec**. Every step assumes the artifact is run.

A whole class of plugin needs a pinned, integrity-verified artifact that is **never executed** — it is DATA a tool
reads: ML model weights, a rules/signature database, a wordlist, a template bundle. The motivating case: a speech-to-
text plugin's engine (`whisper-cli`) needs a `ggml` model file (~140 MB, pinned from a stable HTTPS host). Today there
is no clean way to provision that:

- It is not an executable, so the tool provisioner is wrong for it (smoke-exec fails; `0o500` exec-only is the wrong
  mode; the launcher's "re-validate before exec" doesn't apply).
- It is too large to commit into the plugin's git payload.
- Having the plugin's skill `curl` it at first run is a **band-aid** — it bypasses the engine's pinned-sha256,
  content-addressed, refcounted, fail-closed trust model that every other provisioned artifact gets.

"Done" looks like: a plugin manifest declares a **data artifact** (name-keyed, `{url, sha256}`, optionally per-platform)
the same way it declares a tool; the engine **streams** the download, sha256-verifies it, and installs it
**sha256-content-addressed and READ-ONLY (not executable, no smoke)**; a skill resolves its on-disk path through a
stable resolver that applies the same fd-based integrity checks as the tool launcher; removal is refcounted by content
hash and a clone rehydrates from the lockfile — the tool trust model **minus execution**. With this (plus spec 285 for
the binary), a transcription plugin (the first consumer, a separate migration) provisions its model as a data artifact
while its `whisper-cli`/`ffmpeg` binaries are handled as external-tool requirements.

## Design decisions (folded from the 2026-06-28 codex dueto — SHIP-WITH-CHANGES → all folded)

- **D1 — sha256-first physical identity + refcount** (HIGH): store at `.tachyon/data/sha256/<sha>/<fileName>` (NOT
  `<name>/<sha>/…`); refcount the physical blob by `dataSha256`; the lockfile maps logical `<plugin>/<name>` → that
  blob. Same bytes under different plugin names share one blob; removal deletes bytes only at refcount 0.
- **D2 — streamed hashing/install** (MEDIUM): hash + install by STREAMING, never `readFileSync` the whole blob (the
  spec-265 executable installer reads bytes into memory — tolerable for small CLIs, wrong for 140 MB+ models). Check
  `Content-Length` early when present; still enforce the streamed byte cap.
- **D3 — consent/fetch binding (matches the REAL spec-265 tool path).** The fingerprint binds the integrity facts
  `{name, platform, declaredUrl, sha256, fileName}` — it deliberately does NOT bind `finalUrl` (the redirect-resolved
  URL), exactly as the tool fingerprint omits it: the pinned `sha256`, re-verified at fetch, is the integrity gate, so
  a benign signed/redirect URL change must not re-prompt consent. `finalUrl` is recorded provenance (the plan's
  resolved URL, gathered with `resolveFinalUrl` at apply — same as tools). _Implementation note (codex impl-dueto
  2026-06-28): the original D3 draft said to bind finalUrl + abort on drift; that over-specified vs how 265 actually
  works — the implementation correctly follows 265's no-finalUrl-binding decision, and this text is corrected to match._
- **D4 — resolver guarantee is honest + fd-enforced** (HIGH): `_tachyon-data` returns a path only after the
  launcher-grade pre-return checks — trusted `.tachyon/data` ancestry, `lstat` (no symlink), regular file, owner
  uid/root, no group/other write, `nlink == 1`, hash THROUGH the fd, mode has no exec bit. The guarantee is scoped to
  **"at resolve time"** (a string-returning resolver cannot stop a same-user post-resolve swap — stated, not hidden).
- **D5 — resolver shim materialization** (MEDIUM): the Tachyon-owned `_tachyon-data` resolver must exist for hooks/
  skills even when the plugin provisions NO executable tool and no VS Code process is running; its integrity is
  refreshed like the tool launcher, and the consent's "no executable plugin artifact" language explicitly EXCLUDES this
  Tachyon-owned resolver.
- **D6 — manifest shape** (LOW): `data` is a name-keyed map, not a list with a redundant `name`:
  `data: { model: { version, url, sha256, fileName?, platforms? } }`; names validated by the tool kebab-case rule.
- **D7 — archive is rejected, not ignored** (OQ6): a `data` declaration that looks like an archive is a clear manifest
  error in v1 (single-file only), never silently accepted/ignored.

## Acceptance criteria

- [ ] **Scenario: declare + provision a data artifact (streamed)**
  - **Given** a manifest `data: { model: { version, url (https), sha256, fileName? } }` (optionally `platforms`)
  - **When** the plugin is installed
  - **Then** the engine STREAMS the download, verifies the sha256, and installs it **sha256-content-addressed + read-only (no exec bit, no smoke-check)** under `.tachyon/data/sha256/<sha>/`, recorded in the lockfile — or fails CLOSED (hash mismatch / non-https / redirect downgrade / oversize / finalUrl drift) with a clear reason and no partial install
- [ ] **Scenario: a skill resolves the artifact path with fd-enforced integrity**
  - **Given** an installed data artifact `model`
  - **When** the plugin's skill runs `_tachyon-data <plugin> <name>`
  - **Then** it prints the absolute path only after the D4 checks pass (trusted ancestry, no symlink, regular file, owner, no foreign write, nlink=1, hash-through-fd, no exec) — else exits nonzero `unavailable`; never a fabricated path
- [ ] **Scenario: integrity re-verification at resolve**
  - **Given** an installed data artifact whose bytes were swapped on disk
  - **When** it is resolved
  - **Then** the resolve-time hash mismatch is detected and surfaced — a swapped model never silently resolves (guarantee scoped to resolve time; post-resolve same-user swaps are out of scope, stated honestly)
- [ ] **Scenario: refcounted removal + clone rehydrate (sha-keyed)**
  - **Given** a blob shared by `dataSha256` with another plugin (or a fresh clone with only the lockfile)
  - **When** a plugin is removed (resp. the workspace is rehydrated)
  - **Then** the bytes are deleted only at refcount 0 (never a still-shared blob); a clone re-fetches from the lockfile pin, never a silent unpinned fetch
- [ ] **Scenario: consent reflects no-execution**
  - **Given** an install that provisions a data artifact but no executable tool
  - **When** the consent preview is shown
  - **Then** it discloses a network download + disk write of a pinned, checksummed DATA file — NOT the tool's "downloads AND executes a binary" warning — and excludes the Tachyon-owned resolver shim from "executable plugin artifact"
- [ ] data artifacts and executable tools coexist in one manifest/lockfile without either regressing (the existing tool-provisioning suites stay green)
- [ ] the data path is NEVER executable and is NEVER fed to the tool launcher's (`_tachyon-tool`) exec path
- [ ] an archive-shaped `data` declaration is a clear manifest error (single-file only in v1)
- [ ] tests cover: no-exec-bit install, resolver absent/corrupt error, non-https redirect downgrade, oversize cleanup, concurrent same-hash install, clone rehydrate, and "data path never passed to `_tachyon-tool`"

## Non-goals

- Executing a data artifact, or any code path that runs it — that is what `tools` are for; the whole point is the
  no-execution split.
- Bundling large data inside the plugin git payload (it must be fetched + pinned).
- A general asset CDN / mirror / caching tier beyond the existing content-addressed local install.
- Auto-selecting or downloading model *variants* on demand (the plugin pins exactly what it declares; a different model
  = a different declared artifact / plugin update).
- Archive/multi-file data artifacts in v1 (rejected with an error per D7; deferred).
- Defending against a same-user post-resolve byte swap (the resolve-time guarantee is honest about its boundary, D4).
- Migrating the transcription plugin itself — that is a later spec, the first consumer of this engine feature.
- The external-tool requirement + assisted-install surface for the whisper binary + ffmpeg — that is spec **285**
  (declare → detect → preview → assisted install via the OS's auth → doctor). 284 and 285 are siblings; both land
  before the transcription plugin.

## Open questions

_All resolved by the dueto:_

- **OQ1 — resolution contract.** `_tachyon-data <plugin> <name>`, sibling to `_tachyon-tool`, plugin-scoped,
  lockfile-anchored, cwd-independent, re-verifies on resolve, nonzero on absent/corrupt. (→ D4)
- **OQ2 — per-platform.** Single blob by default + optional `platforms`, reusing the existing platform resolver. (→ D6)
- **OQ3 — re-verification cadence.** Re-verify on every resolve, via STREAMING hash; document the path-return race
  boundary. (→ D2, D4)
- **OQ4 — size cap.** Separate `MAX_DATA_ARTIFACT_BYTES`; default **1 GiB** as the runaway breaker, with tests proving
  140 MB-class files are normal.
- **OQ5 — consent granularity.** A separate, lighter data consent: network download + disk write + sha256 integrity,
  explicitly no plugin-provided executable.
- **OQ6 — archive support.** Single-file only this spec; an archive declaration is a clear manifest error (→ D7).

## Context / references

- spec 265 — tool provisioning (the executable sibling this extends): `src/plugins/toolProvisioning.ts` (download →
  verify → smoke-EXEC → install `0o500`; note its `readFileSync` install — D2 streams instead), `toolLauncher.ts`
  (the fd-based integrity + host-path trust checks D4 mirrors), `toolProvisionRun.ts`, `lockfile.ts`, `toolPlan.ts`,
  `consentViewModel.ts`.
- spec 272 (dep-audit) — the `_tachyon-tool` launcher-by-workspace-relative-path contract `_tachyon-data` mirrors.
- spec 285 — external-tool-requirements (the binary side of the same transcription migration); siblings.
- Trust-model invariants (project handoff § Decisions): pinned per-artifact `{url, sha256}`; content-addressed immutable
  install; refcounted removal; clone rehydrates from the lockfile, never a silent fetch; fail-closed on
  corrupt/oversize/non-https; finalUrl is recorded provenance, the consent fingerprint binds it (D3).
- Motivating consumer (next spec): a speech-to-text plugin — `whisper-cli` + `ffmpeg` (spec 285) + a `ggml` model
  (this spec's data artifact). The engine evolutions land FIRST; the plugin migrates on top of them.
