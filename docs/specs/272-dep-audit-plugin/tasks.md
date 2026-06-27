# 272 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/pluginToolProvisioning.test.ts test/unit/pluginToolLauncher.test.ts test/unit/pluginToolPlan.test.ts`
<!-- extend with the new raw-provisioning + skill→tool suites once they land -->

## Lane A — Tachyon core (this repo) — COMPLETE (real-binary proof moves to Lane B / I1)

- [x] A0. **OQ1 decided** — skill→tool contract = call the launcher by workspace-relative path
  `"<repo-root>/.tachyon/bin/_tachyon-tool" <plugin> <tool> [args]` (repo-root via `git rev-parse --show-toplevel`;
  launcher-absent → `unavailable`). Documented in spec.md (OQ1 RESOLVED) + notes.md.
- [x] A1. **`${tool:}` stays rejected in a git-hook script leaf** — existing coverage confirmed
  (`pluginToolTransaction.test.ts:80` `containsToolPlaceholder`; `pluginToolHook.test.ts:50` engine reject).
- [x] A2. **Skill→tool contract enforcement** — `skillToolPlaceholderWarnings()` added (`engine.ts`, mirrors
  `placeholderTypoWarnings`): a non-blocking install WARNING when a skill payload file contains `${tool:…}`,
  pointing to the launcher contract. New test in `pluginEngine.test.ts`; full unit suite green (1648) + typecheck.
- [x] A3. **Raw (no-`archive`) provisioning proven end-to-end** — ALREADY covered by `pluginToolProvisionRun.test.ts`
  (5 tests, RUN here not skipped): the `mytool` fixture is a RAW binary (no `archive`) exercised through real-HTTPS
  download → content-addressed install (asserts mode `0o500`) → `smokeCheck --version` (install succeeds only if
  smoke passes) → launcher materialize → removal/refcount → **rehydrate after wiping `.tachyon/bin` (clone/CI)** →
  checksum-mismatch rollback. The synthetic chain is proven; only the REAL osv-scanner binary remains → Lane B / I1.
- [x] A4. **No latent bug** — raw path is correct on inspection AND green under the A3 tests. Nothing to fix in core.
- [x] A5. **`versionArgs` NOT manifest-exposed** (OQ3) — the provision path calls `smokeCheck(installPath)` with no
  opts, so smoke is HARDCODED to `--version` (`toolProvisionRun.ts:119`). osv-scanner supports `--version` (codex
  verified `2.3.8`; re-verify the exact pin in B1), so this is fine. A future tool lacking `--version` would need a
  core `versionArgs` plumb — deferred (YAGNI), flagged here.

## Lane B — the dep-audit plugin (tachyon-plugins repo) — BUILT

- [x] B1. **osv-scanner pinned v2.4.0** — per-platform `sha256` from the release `osv-scanner_SHA256SUMS`.
  **Real-binary verified:** downloaded the pinned `osv-scanner_linux_amd64` (56.7 MB) → sha256 matches the manifest
  EXACTLY → `--version` exits 0 (`2.4.0`) → real scan works. Other platforms' shas are from the official SUMS.
- [x] B2. **`tachyon-plugin.json`** — `name:"dep-audit"`, runtimes claude+codex, `tools.osv-scanner` RAW
  per-platform `{url, sha256}` (NO `archive`; linux glibc+musl share the static Go binary). No `gitHooks`/`config`.
  Engine-validated: loadPlugin 0 errors, toolPlan resolves `osv-scanner → linux-x64-glibc` `hasArchive:false`.
- [x] B3. **`skills/dep-audit/scripts/audit.sh` ported** — binary resolution via the launcher contract (engine()
  wrapper, `DEP_AUDIT_ENGINE` override for tests); status model + flags + ecosystem coverage + provisioning-
  failure→`unavailable` preserved. Port refinements (real bugs fixed, not transcribed): empty-array `[""]` count,
  `--severity=` validation, monorepo basename-collision coverage, engine-stderr surfacing, 3+-ecosystem delimiter.
- [x] B4. **`skills/dep-audit/SKILL.md` ported** — de-harnessed; runtime-agnostic invocation (probes `.agents/`
  then `.claude/`); no `${tool:}` token (engine preview warnings: []).
- [x] B5. **README.md** — ecosystem/lockfile matrix, advisory-only statement, CI/own-hook recipe.

## Integration / proof

- [x] I1. **Dogfood** — via `DEP_AUDIT_ENGINE` against the REAL pinned v2.4.0 binary: `findings` (lodash, sev/CVE/
  fix/direct), `clean` (found=0), `unavailable` (no launcher), `failed` (+stderr excerpt), `--exit-code` 1/0,
  `--severity` floor, `--json` shape, `bun.lockb`→skipped (not clean), monorepo coverage correct. (Full Tachyon
  install-time provisioning of the RAW binary is covered by the Lane A synthetic e2e + the real-sha verification.)
- [x] I2. **Codex dueto on the built plugin** — SHIP-WITH-CHANGES; all 6 findings folded (codex path, `--severity=`,
  stderr surfacing, monorepo coverage, real-binary proof, delimiter). Transcript `…/20260627T023107Z-…/`.
- [ ] I3. **Tag** a release in the plugins repo — GATED (no publish/tag without the maintainer's ask).

## Verification

- [ ] raw-binary provisioning proven end-to-end by test (A3), not just source audit (scenario 1)
- [ ] a skill script invokes a provisioned tool via the documented launcher contract; `${tool:}` stays rejected in
  scripts (scenarios 1-2, A1-A2)
- [ ] osv-scanner pinned + `--version`-verified per platform from SHA256SUMS (scenario 3, B1)
- [ ] status mapping faithful: provisioning failure → `unavailable`, never `clean`/`failed` (scenario 4, B3)
- [ ] no `gitHooks`, nothing in `core.hooksPath`; no file edited (scenario 5)
- [ ] no source-harness leakage in any plugin artifact (scenario 6)
