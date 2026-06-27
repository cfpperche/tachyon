# 272 — dep-audit-plugin

_Created 2026-06-27._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->
<!-- Lane A (core) COMPLETE 2026-06-27: OQ1 closed; skill→tool warning shipped + tested; raw provisioning proven by
     existing pluginToolProvisionRun tests; A5 resolved. Next: Lane B (the plugin) in the tachyon-plugins repo. -->

> **Codex dueto (2026-06-27) — verdict: SHIP-WITH-CHANGES; folded.** Review transcript:
> `.agent0/.runtime-state/codex-exec/20260627T012254Z-read-the-design-brief-…/`. Folded: advisory-only v1 (no
> gate — always-on no-op hook is a trap); raw-binary provisioning needs an END-TO-END proof, not a source audit;
> the `${tool:}` placeholder does NOT resolve inside a skill script (only a git-hook argv leaf) → a real
> skill→tool invocation contract is required; ecosystem/lockfile matrix + provisioning-failure→`unavailable`
> status mapping must be explicit; **name = `dep-audit`**.

## Intent

Port the on-demand known-vulnerability dependency scanner into the Tachyon plugin system as a marketplace plugin
named **`dep-audit`** — an OSV-backed audit of a repo's INSTALLED dependency lockfiles (npm/bun, PyPI, Go, crates,
Packagist, RubyGems, Maven, NuGet) that REPORTS + PROPOSES upgrades and never auto-fixes, never gates install or
commit. Engine = **osv-scanner** (Google), provisioned as a pinned binary.

This is the first capability migrated after the five-capability core stabilized, chosen because it is self-contained
and exercises the plugin system in a NEW direction (skill-PRIMARY, not git-hook-primary like `secrets-guard`). In
doing so it is the **first real consumer of two core paths that have shipped but never been dogfooded end-to-end**,
so this spec has two lanes:

- **Lane A — Tachyon core (prove + harden the paths `dep-audit` is first to use).**
  1. **Raw (non-archive) tool provisioning.** osv-scanner ships RAW per-platform binaries (no tar.gz), unlike
     gitleaks. The provisioner supports this (`toolPlan.ts` optional `archive`; `toolProvisioning.ts:271`
     `chmod(0o500)` is archive-agnostic; `smokeCheck` runs `--version`) AND — verified during this spec — the full
     raw chain is already exercised end-to-end by `pluginToolProvisionRun.test.ts` (the `mytool` raw fixture). So
     Lane A.1 is DE-RISKED: the synthetic proof exists; only the REAL osv-scanner binary dogfood remains (Lane B).
  2. **Skill-script → provisioned-tool invocation contract.** `${tool:<name>}` resolves ONLY in a git-hook argv
     leaf and is explicitly REJECTED in any script leaf (`toolPlaceholder.ts:53`, `engine.ts:435-437`). A skill
     payload script therefore has NO blessed way to call a provisioned tool today. Define one.
- **Lane B — the `dep-audit` plugin (built in the `tachyon-plugins` repo, NOT bundled in core).** Manifest
  declaring a raw `osv-scanner` tool + a skill payload (`SKILL.md` + `scripts/audit.sh` ported from the source
  ~382-line engine, with binary resolution swapped to the Lane-A contract). Advisory-only; no gate.

**Non-goals / deferred:**
- **No commit/push gate in v1.** spec-270 `config` is a passive, "not a security input" file and CANNOT drive
  conditional capability materialization, so the clean opt-in-gate shape does not exist. An always-on hook that
  reads config and `exit 0`s is rejected (silently wires `core.hooksPath`, fixes the event too early, fakes a
  security boundary around a non-security file, contradicts the on-demand source contract). A real gate is a
  FUTURE spec that first gives Tachyon an explicit optional-materialization primitive (e.g. "enable hook profile").
- No custom lockfile parsing (osv-scanner owns ecosystem detection; the plugin states the contract, not the parser).
- No auto-fix / `osv-scanner fix --apply` / manifest edits.

## Behavior contract (ported, unchanged from source intent)

- ON-DEMAND. Detect + report + PROPOSE. Never gates install/commit; never edits a manifest/lockfile.
- Result statuses, decoupled from exit code: `clean` | `findings` | `unavailable` | `failed`.
  - **`unavailable`** = the engine could not be RUN — binary missing, smoke-check fail, launcher hash-validation
    refusal, or any provisioning failure. NEVER report this as `clean` or `failed` (it is "we could not scan").
  - **`failed`** = the engine RAN but errored / produced unparseable output.
  - Unsupported/skipped lockfiles are surfaced as "not scanned", never folded into `clean`.
- `--severity <low|moderate|high|critical>` floor; `--json` (shape-only, not a wire contract); `--exit-code` maps
  status→exit (`clean=0 findings=1 unavailable=2 failed=3`) ONLY when passed (advisory family — default always 0).
- Source-completeness honesty: "no known-vulnerable deps found BY THE OSV-BACKED ENGINE", not "no vulns exist".

## Ecosystem / lockfile support matrix (user-facing contract)

Detection is osv-scanner's; the plugin documents what it expects to be scanned and that anything else is
"not scanned, not clean":

| Ecosystem | Source files osv-scanner reads |
|---|---|
| npm | `package-lock.json`, `npm-shrinkwrap.json` |
| pnpm | `pnpm-lock.yaml` |
| Yarn | `yarn.lock` (Berry caveats) |
| Bun | `bun.lock` (text); legacy binary `bun.lockb` → surface "migrate to text lockfile", not clean |
| Python | `requirements*.txt`, `poetry.lock`, `Pipfile.lock`, `uv.lock` |
| Go | `go.mod` (+ `go.sum`) |
| Rust | `Cargo.lock` |
| PHP | `composer.lock` |
| Ruby | `Gemfile.lock` |
| Maven/Gradle | `pom.xml`, Gradle lockfiles where supported |
| NuGet | `packages.lock.json`, `packages.config`, `project.assets.json` |

The plugin MUST state coverage is "what the pinned osv-scanner version detects" and surface per-ecosystem
"not scanned" reasons rather than implying a clean repo.

## Acceptance criteria

- [x] **Scenario: raw-binary provisioning works end-to-end (Lane A.1) — ALREADY PROVEN**
  - **Given** a manifest tool entry with NO `archive` block (raw `{url, sha256}`)
  - **When** the tool is provisioned, smoke-checked, launched, removed, and rehydrated-from-lockfile
  - **Then** download → content-addressed install → `chmod 0o500` → owner/nlink checks → `smokeCheck --version` →
    launcher materialize → refcounted removal → clone-rehydrate all succeed. **Proven by `pluginToolProvisionRun.test.ts`
    (5 tests, RUN not skipped): the `mytool` fixture is a RAW binary.** Synthetic chain proven; the REAL osv-scanner
    binary proof is the Lane B dogfood (I1), not a re-build.

- [ ] **Scenario: a skill-payload script can invoke a provisioned tool (Lane A.2)**
  - **Given** `dep-audit`'s `scripts/audit.sh` needs to run the provisioned `osv-scanner`
  - **When** the agent runs the skill in the repo
  - **Then** there is a DOCUMENTED, TESTED contract for the script to resolve + invoke the tool through the
    plugin-scoped launcher (re-validated each exec) — NOT a literal `${tool:...}` (which fails closed in a script
    leaf). The chosen contract (see Open questions) is asserted by a test.

- [ ] **Scenario: osv-scanner is pinned + reproducible**
  - **Given** osv-scanner v2.4.0 (pin to verify) release assets `osv-scanner_{linux,darwin}_{amd64,arm64}` (+ win)
  - **When** the manifest is authored
  - **Then** every platform entry has `{url, sha256}` taken from the release `osv-scanner_SHA256SUMS`, and
    `osv-scanner <veratim pinned> --version` is verified to exit 0 (hard acceptance item, not a TODO). If
    `--version` is unsupported by the pin, a `versionArgs`/smoke override path is identified (core gap if absent).

- [ ] **Scenario: status mapping is faithful**
  - **Given** the four result states
  - **Then** binary-missing / smoke-fail / hash-refusal / provisioning failure → `unavailable`; engine-ran-but-
    errored → `failed`; engine-ran-no-findings → `clean`; ≥1 vuln → `findings`; unsupported lockfiles surfaced as
    "not scanned". `--exit-code` maps `clean=0 findings=1 unavailable=2 failed=3`; default exit always 0.

- [ ] **Scenario: advisory-only, no gate**
  - **Then** the plugin declares NO `gitHooks` and materializes nothing into `core.hooksPath`; it proposes
    upgrades for fixable direct deps but edits no file. Docs note CI/own-hook recipes for teams wanting a gate.

- [ ] **Scenario: no source-harness leakage**
  - **Then** the plugin manifest/SKILL.md/scripts/README name NO originating personal harness, embed no private
    `/home/<user>` path, and carry the `dep-audit` identity only.

## Open questions

- **OQ1 — RESOLVED (2026-06-27): the skill→tool invocation contract = call the launcher by its workspace-relative
  path; option (a).** A skill payload script invokes a provisioned tool as
  `"<repo-root>/.tachyon/bin/_tachyon-tool" <plugin> <tool> [args]`, resolving `<repo-root>` via
  `git rev-parse --show-toplevel` (fallback: walk up from cwd for a `.tachyon/bin/_tachyon-tool`). The launcher shim
  (`toolLauncher.ts:307 materializeLauncher`) is a POSIX-sh that `cd`s to its own dir and execs the recorded
  absolute Node on the adjacent `_tachyon-tool.js`, so it is **cwd-independent** and re-validates the binary hash on
  EVERY exec — the script MUST go through it, never the raw `.tachyon/bin/<tool>/<sha>/<tool>` (that would bypass
  re-validation). `.tachyon/bin/` is regenerated per managed op and not committed, so **launcher-absent → report
  `unavailable`** (a fresh clone before provisioning has no shim).
  - *Why not (b)/(c):* (b) a spawn-time `TACHYON_TOOL_*` env doesn't survive a manually-run script and couples to
    agent spawn; (c) a new `tachyon tool …` indirection is core surface we don't need — the launcher already IS the
    indirection. Option (a) is **zero new core code** for the happy path.
  - *`${tool:…}` is NOT the contract:* it resolves ONLY in a git-hook argv leaf (`toolPlaceholder.ts:17`) and a
    skill payload is materialized VERBATIM (no substitution), so `${tool:…}` in a skill script reaches the agent
    literally and silently breaks. Lane A.2's core change is a **non-blocking install WARNING** when a skill
    payload file contains `${tool:…}`, pointing the author to this launcher contract (mirrors the existing
    `placeholderTypoWarnings`). Not a hard reject — a skill `SKILL.md` may legitimately *document* the token, and
    there is no security boundary here (no substitution is attempted), so warn-don't-block is proportionate.
- **OQ2:** pin osv-scanner v2.4.0 or a later/LTS? Verify `--version` on the exact pin.
- **OQ3:** does the tool/manifest schema expose `versionArgs` (smoke override)? If not and a pin ever drops
  `--version`, that's a core schema gap to track (not a plugin workaround).

## Notes

- Source artifacts to port: the ~382-line engine + ~51-line SKILL.md + rule. Port = refinement, not transcription:
  audit for over-prescription, but the ONLY mechanical change is binary resolution (PATH → Lane-A.2 contract).
- The raw-provisioning chain is proven synthetically (Lane A.1, verified); the real-osv-scanner-binary dogfood
  (Lane B / I1) is the last unproven step — expect any latent surprise there (real ELF size/smoke/network), not in
  the already-green synthetic chain.
