# 272 — notes

## Decisions

- **Name = `dep-audit`** (Codex + agreed). More precise than `vuln-audit` (audits DEPENDENCIES, not arbitrary app
  vulns); "audit" fits the report/propose workflow better than "scan" (one-shot) or "watch" (monitoring); avoids
  `-guard` (it does NOT guard/gate). Subtitle: "On-demand OSV vulnerability audit for dependency lockfiles."
- **Advisory-only v1, NO gate.** spec-270 `config` is passive + "not a security input" and cannot drive conditional
  capability materialization. An always-on no-op pre-commit hook was considered and REJECTED as a trap. The gate is
  a future spec contingent on Tachyon gaining an explicit optional-materialization primitive.
- **Two lanes:** core (prove raw provisioning + define skill→tool contract) before plugin.

## Verified source evidence (Tachyon repo, 2026-06-27)

- Raw binary support is real: `toolPlan.ts` `archive?` optional + raw branch (`binSha256 = p.archive ?
  p.archive.binSha256 : p.sha256`); `toolProvisioning.ts:225 installExecutable` archive-agnostic, `chmod(0o500)` at
  :271, owner/nlink checks, re-hash; `smokeCheck` :521 runs `--version` in a scrubbed-env sandbox;
  `toolProvisionRun.ts:102` extract branch only `if (item.archive)`. No schema requires `archive`.
- `${tool:}` is git-hook-argv ONLY: `toolPlaceholder.ts:17` whole-token regex; `:53-54` + `engine.ts:435-437`
  REJECT it in a script/free-form leaf. → skills need a different invocation contract (Lane A.2 / OQ1).
- Launcher: `_tachyon-tool <plugin> <tool> [args]` (`toolLauncher.ts:225`); shim at `.tachyon/bin/_tachyon-tool`
  (`TACHYON_BIN_REL = ".tachyon/bin"`), re-validates hash each exec.

## osv-scanner release facts (verified)

- GitHub `google/osv-scanner` ships RAW binaries (no archive): `osv-scanner_linux_amd64`, `osv-scanner_linux_arm64`,
  `osv-scanner_darwin_amd64`, `osv-scanner_darwin_arm64`, `osv-scanner_windows_amd64.exe`,
  `osv-scanner_windows_arm64.exe`, + `osv-scanner_SHA256SUMS` (source of per-platform sha256).
- Codex locally verified osv-scanner `2.3.8 --version` exits 0 (smoke-check plausible). Still verify the EXACT pin.

## Codex dueto (2026-06-27) — SHIP-WITH-CHANGES, findings folded

Transcript: `.agent0/.runtime-state/codex-exec/20260627T012254Z-read-the-design-brief-…/`.
1. Raw provisioning source-supported but unproven → end-to-end test required (folded: A3, scenario 1).
2. Advisory-only v1 right; no always-on no-op hook (folded: Non-goals, scenario 5).
3. `${tool:}` not valid in skill scripts → need a real invocation contract (folded: Lane A.2, OQ1, A1-A2).
4. Ecosystem/lockfile matrix + "not scanned ≠ clean" under-specified (folded: matrix table, status contract).
5. Provisioning failure → `unavailable`, not `failed`/`clean` (folded: status contract, scenario 4).
   Name → `dep-audit` (folded).

## Lane A progress (2026-06-27) — COMPLETE (real-binary proof → Lane B)

- **OQ1 CLOSED:** skill→tool contract = invoke `"<repo-root>/.tachyon/bin/_tachyon-tool" <plugin> <tool> [args]`
  (repo-root via `git rev-parse --show-toplevel`; launcher is cwd-independent + re-validates hash each exec;
  launcher-absent → `unavailable`; NEVER call the raw `.tachyon/bin/<tool>/<sha>/<tool>`, that bypasses
  re-validation). `${tool:}` is NOT the contract (skill payloads are verbatim, no substitution).
- **A2 shipped (core):** `skillToolPlaceholderWarnings()` in `engine.ts` — a non-blocking install warning when a
  skill payload file contains `${tool:…}`, pointing to the launcher contract (mirrors `placeholderTypoWarnings`;
  wired after it in `previewInstall`). New test in `pluginEngine.test.ts`. Full unit suite green (1648) + typecheck.
  Chosen warn-not-reject: no substitution is attempted (no security boundary) + a SKILL.md may legitimately
  document the token.
- **A3 ALREADY PROVEN:** `pluginToolProvisionRun.test.ts` (5 tests, RUN here, not skipped) exercises the RAW
  (no-`archive`) chain end-to-end with the `mytool` fixture: HTTPS download → install (asserts mode `0o500`,
  `:81`) → `smokeCheck --version` (`toolProvisionRun.ts:119`; install succeeds only if smoke passes) → launcher
  materialize → removal/refcount → rehydrate-after-`.tachyon/bin`-wipe → checksum-mismatch rollback. So raw was
  NOT actually un-dogfooded — only the real osv-scanner binary remains (Lane B / I1).
- **A5 resolved:** the provision path calls `smokeCheck(installPath)` with NO opts → smoke is hardcoded to
  `--version`. No manifest `versionArgs` override exists. osv-scanner supports `--version` (codex: `2.3.8`;
  re-verify the pin in B1). A future tool without `--version` would need a core `versionArgs` plumb — deferred.

## Lane B built (2026-06-27) — plugin in `tachyon-plugins/dep-audit/`

Files: `tachyon-plugin.json` (raw osv-scanner v2.4.0, 6 platform keys, no archive), `skills/dep-audit/SKILL.md`,
`skills/dep-audit/scripts/audit.sh` (ported engine), `README.md`.

- **Real-binary proof (B1):** downloaded the pinned `osv-scanner_linux_amd64` v2.4.0 → sha256 == manifest pin
  (`15314940…`) → `--version` exits 0 (`2.4.0`) → real `scan --format json --recursive` works. The raw-binary
  shipping surface is proven on the actual asset, not inferred.
- **Engine validation:** loadPlugin 0 errors; skill discovered (claude+codex); toolPlan `osv-scanner →
  linux-x64-glibc`, `hasArchive:false` (RAW); previewInstall 0 errors + **0 warnings** (the spec-272 `${tool:}`
  warning correctly does NOT fire — the script uses the launcher path).
- **Codex dueto (round 2, on the BUILT plugin) — SHIP-WITH-CHANGES; all 6 folded** (transcript
  `…/20260627T023107Z-…/`): (1) runtime-correct invocation — SKILL.md/README now probe `.agents/` then `.claude/`
  instead of hardcoding `.claude/`; (2) `--severity=<v>` now validates (was a silent no-floor footgun); (3) engine
  stderr captured + surfaced on `failed` (was `2>/dev/null` — would hide a launcher hash-revalidation refusal);
  (4) coverage compares SCAN_PATH-relative paths, not basenames (monorepo `apps/{a,b}/package-lock.json` no longer
  cross-cover); (5) real-binary proof done (above); (6) ecosystem delimiter `paste -sd, | sed` (was `paste -sd', '`
  which cycles `,`/` ` → `npm,PyPI Go`). Plus a port-found latent bug: empty-array `"${ARR[@]:-}"` → `[""]` count.
- **Dogfood (I1):** all statuses + flags verified against the real v2.4.0 binary via `DEP_AUDIT_ENGINE`.

## v2 ideas (backlog — NO demand yet; ship v1 first, let real use pull these)

Principle: a good v2 DEEPENS the same job (triage known-vulnerable deps) without breaking advisory-only
(report/propose, never auto-fix, never gate). Things that become "another product" (license/policy checks,
continuous monitoring) belong in a separate plugin, not here.

1. **Accepted-exceptions list (best fit).** Let the human register "this finding I've assessed as not-applicable,
   for this reason, until this date" in a human-owned file the script reads, so repeat scans stop re-surfacing
   accepted risk. **Fits the spec-270 `config` mechanism** (passive, human-owned file) — the exact thing v1's
   config couldn't be used for *gating* but CAN be used for here. Doesn't violate advisory-only (human decides,
   with reason + expiry). Cheapest + most philosophy-aligned → do FIRST when demand lands.
2. **Transitive remediation path.** Today a "came-along" (transitive) finding reports "no direct remediation path".
   v2 computes WHICH direct dependency to bump to pull in the fixed transitive (the dependency chain). Biggest
   jump in real triage value; more engine work.
3. **"Only what's new" / baseline-diff mode.** Show only findings a given change/PR INTRODUCED vs a prior snapshot —
   pairs with PR review (did this PR worsen security?) without drowning in pre-existing findings. Needs a stored
   baseline.
4. **Opt-in gate (the deferred big one).** An optional, human-enabled gate (e.g. block a push on a critical
   finding). NOT plugin-only: needs Tachyon CORE to first grow a "materialize a capability ONLY when the human opts
   in" primitive — without it, any shortcut is the always-on-no-op-hook trap the spec already rejected. Half-plugin,
   half-core → most expensive; only on real demand.

Lean: #1 first (cheap, fits existing config), then #2 (biggest value); #3/#4 demand-gated.

## Still open

- **I3 — tag a `tachyon-plugins` release: GATED** (no publish/tag without the maintainer's ask).
- Full Tachyon install-time provisioning of the RAW binary (download→install→launcher→smoke) is covered by the
  Lane A synthetic e2e (`pluginToolProvisionRun.test.ts`) + the real-sha verification; a live VS Code install would
  be the final belt-and-suspenders but needs the extension runtime (can't drive headlessly).
- `jq` is a host dependency the plugin can't provision (documented in SKILL.md/README).
