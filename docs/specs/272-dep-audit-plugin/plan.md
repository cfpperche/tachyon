# 272 — plan

## Approach

Two lanes, Lane A (Tachyon core) BEFORE Lane B (the plugin), because Lane B can't be built honestly until A.2
(the skill→tool contract) is decided and A.1 (raw provisioning) is proven.

### Lane A — Tachyon core (in this repo)

**A.1 — prove + harden raw (non-archive) tool provisioning.**
- Add an end-to-end / integration test that provisions a RAW binary (a tiny raw-binary fixture, or the real
  osv-scanner asset behind a network-gated test) through the full chain: download → `installExecutable`
  (`toolProvisioning.ts:225`, incl. `chmod 0o500` at :271, owner/nlink, re-hash) → `smokeCheck` (:521,
  `--version`) → launcher hash re-validation (`toolLauncher.ts`) → refcounted removal → clone-rehydrate from
  lockfile (`toolProvisionRun.ts:213`).
- If a latent bug surfaces (mode, smoke, leaf naming, rehydrate), FIX in core. Most likely-fine on inspection;
  the test is the proof the source audit can't give.

**A.2 — decide + implement the skill→tool invocation contract (OQ1).**
- Confirm by test that `${tool:...}` is rejected in a skill/script context (lock in the current fail-closed).
- Implement the chosen contract (lean: bless `.tachyon/bin/_tachyon-tool <plugin> <tool>` as a documented public
  integration point callable from a skill script). Add a test asserting a skill script can resolve + invoke a
  provisioned tool through the launcher and get re-validation on each exec.
- Document the contract where plugin authors will find it (skill-payload authoring docs).

### Lane B — the `dep-audit` plugin (in the `tachyon-plugins` repo)

- `tachyon-plugin.json`: `name: "dep-audit"`, `runtimes: ["claude","codex"]`, `tools.osv-scanner` (raw per-platform
  `{url, sha256}` from `osv-scanner_SHA256SUMS`, NO `archive`), and `skills` auto-discovered from `skills/dep-audit/`.
- `skills/dep-audit/SKILL.md`: ported, de-harnessed, paths updated; "when to run" + remediation discipline +
  source-completeness honesty preserved.
- `skills/dep-audit/scripts/audit.sh`: ported engine; swap PATH resolution → the A.2 launcher contract; keep the
  status model (`clean|findings|unavailable|failed`), `--severity|--json|--exit-code`, ecosystem coverage reporting.
- README.md: ecosystem/lockfile matrix, advisory-only statement, CI/own-hook recipe for teams wanting a gate.
- Tag a release in the plugins repo once dogfooded.

## Sequencing

A.2 (contract) → A.1 (raw proof) → B (plugin) → dogfood B against a repo with a known-vulnerable lockfile,
asserting each status → fold a final Codex dueto on the built plugin → tag.

## Risks

- Raw provisioning latent bug (Lane A.1) — mitigated by doing it as a real test first.
- The skill→tool contract leaks Tachyon internals (`.tachyon/bin/`) — mitigated by blessing it as a documented
  contract rather than an accidental dependency; revisit if a cleaner primitive is built.
- osv-scanner pin drops `--version` — mitigated by verifying the exact pin + identifying the `versionArgs` path.
