# The dogfood ↔ product boundary

> **Invariant:** every surface where Tachyon's development infrastructure touches the product
> artifact must have a **testable forcing function** — something that fails the suite when the
> boundary is crossed. Documented intent (a comment, an ignore line, a convention) is not a
> boundary; it is a hope.

Ratified by the maintainer on 2026-07-10, after an audit found three dev-only artifacts shipping
in every user install (t-009d2f). His framing, agreed: *"estávamos misturando a infra de
desenvolvimento do tachyon com a proposta do tachyon como um produto"* — a process failure.

## Why this keeps happening (the structural cause)

Tachyon is **self-hosted**: this repo is simultaneously the product and the product's development
environment. The same `dist/` holds bundles users run and harnesses only we use; the same
`tachyon.yml` grammar configures a user's fleet and our own; the same activation path serves a
marketplace install and a dogfood build. The boundary between *"this is Tachyon"* and *"this is
how we build Tachyon"* is therefore **invisible by default** — nothing physical separates the two,
so leaks are the path of least resistance, not a mistake someone makes.

Consequence: the boundary only exists where a test enforces it.

## The rule

1. When a change touches `dist/`, packaging (`.vscodeignore`, `vsce`), CI/release, or the
   activation path, ask: **does this surface mix dev infra with the product artifact?**
2. If yes, the change lands **with** its forcing function — a test that fails when the boundary is
   crossed, in the same PR/landing. Not a follow-up, not a comment.
3. Register the boundary in the table below, pointing at its lock.
4. When auditing, audit the **built artifact** (unpack the VSIX and enumerate), never the config
   that claims to shape it. The .vscodeignore line that "excluded" the preview harness never
   worked; only unzipping the VSIX revealed it.

## Registry of known boundaries

| Boundary | State | Lock / evidence |
|---|---|---|
| VSIX ships only allowlisted files (no dev harness, fixtures, source maps) | 🔒 locked | `test/unit/cxShipBoundaryBehavior.gen.test.ts` pins `scripts/ship-boundary.mjs` both ways: dev artifacts excluded AND load-bearing files (`extension.js`, `package.json`, `provenance.json`) included. Prune pipeline: `scripts/prepare-package.mjs` (t-009d2f). |
| Embedded provenance record matches shipped bits | 🔒 locked | Prune runs **before** `record-provenance.mjs embed`, so the sentinel's record describes the post-prune tree (verified end-to-end: 188 files, 0 mismatch). Behavior test `snProvEmbedBehavior` pins workspace-independence + the `!provenance.json` allowlist line. |
| Provenance **sentinel** (dogfood) vs governed **release boundary** (product) | 🔒 separated | Split into t-d0fc4f (dogfood: Tachyon hashes its own install; honest "unverified build" wording, never "tamper-proof") and t-a1faec (product: artifact provenance as evidence + brokered outward actions). The asymmetry is documented in both: a user project's root of trust lives off-machine; ours cannot. |
| `verify_task` default stays generic (`npm test`), never Tachyon's build-aware `verify:full` | 🟡 intent only | Correct today (`DEFAULT_FULL_VERIFY` in `src/bridge/verifyTask.ts`); Tachyon overrides in its own `tachyon.yml`. No test pins that the DEFAULT remains project-agnostic. |
| `contributes.configuration` defaults carry no Tachyon-repo assumptions | 🟡 intent only | Audited clean 2026-07-10 (8 settings, no tachyon-specific defaults). Nothing prevents a future setting defaulting to e.g. a `docs/specs` path or an `npm run verify:full`. |
| `Tachyon: Init` scaffolds from the USER's stack (multi-ecosystem detection) | 🟡 partial | Detects `package.json`/`composer.json`/`Cargo.toml`/`go.mod`/`pyproject.toml`/`requirements.txt`/`Gemfile`; init tests exist, but no test asserts the generated yml never embeds Tachyon-only commands. |
| `tachyon.yml` in this repo is dogfood fleet config living inside the product repo | 🟡 open | Discussed 2026-07-10: the file also carries `settings.verify` (tamper-evident only while tracked). Candidate design: `tachyon.local.yml` overlay (needs `CONFIG_FILENAMES` + merge support) keeping the versioned file canonical. |
| Build stamp keeps bundles byte-deterministic (no timestamp/random) | 🔒 locked by review + forensics practice | `__TACHYON_BUILD__` carries only `{commit, treeSha, dirty}`. Determinism was the forensic tool that caught the 0.55.88 out-of-band install; verified empirically (two independent builds, identical hashes). No dedicated test — relies on the provenance behavior tests failing if hashing diverges. |

🔒 = held by a forcing function. 🟡 = held by intent/audit only — correct today, unguarded.

A 🟡 entry is not an emergency; it is a **known unlocked door**. Promote it to 🔒 when it starts
moving (or when an audit finds it drifted). What is not allowed is a boundary that exists in
nobody's head and no table — that is how ~27MB of dev artifacts shipped for weeks unnoticed.

## Prior incidents (why the rule earns its keep)

- **t-009d2f (2026-07-10):** `dist/webview-preview/` (~274KB dev preview harness), the spec-350
  `agent-studio-fixture` "fake" (zero user path), and 26 source maps (~27MB) shipped in every
  install. The `.vscodeignore` exclusion was documented and dead.
- **`!provenance.json` (t-d0fc4f follow-up):** one dropped allowlist line would ship a silently
  blind sentinel — found during review, now pinned by test.
- **Per-workspace provenance record:** the sentinel initially read its record from the OPEN
  WORKSPACE — a machine/install fact stored in a project-relative path. Worked only in the Tachyon
  repo; fixed by embedding the record in the VSIX (t-d0fc4f follow-up).
- **0.55.88 out-of-band install (2026-07-09):** an agent built from an uncommitted tree, installed
  and reloaded, same version string as the legit deploy. Caught only by hand-hashing 216 files.
  Produced the sentinel + the build stamp (dirty self-report).
