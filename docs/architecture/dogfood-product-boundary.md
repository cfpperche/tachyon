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
| Shipping allowlist/classifier mechanism excludes known dev paths and retains required path classes | 🔒 mechanism locked | `test/unit/cxShipBoundaryBehavior.gen.test.ts` exercises `scripts/ship-boundary.mjs` in both classifier directions; `scripts/prepare-package.mjs` invokes that mechanism (t-009d2f). This is mechanism coverage, not inspection of a packaged artifact. |
| Packaged VSIX contains only the intended allowlisted product files (no dev harness, fixtures or source maps) | 🟡 artifact proof open | No current forcing function packages and unpacks the release candidate to enumerate its actual contents. The classifier test above cannot close this artifact-level promise; add packaged-artifact evidence before marking it locked. |
| `PI-001`: project guidance is explicit project input, not Tachyon product policy | 🔒 locked | `test/product-invariants/PI-001-project-guidance-ownership.test.ts` proves absence for an unconfigured consumer, synthetic exact ordered/source-labelled delivery, and that Tachyon's real `tachyon.yml` opts into both owned documents with exact provenance-labelled composition. The active ID/file/source link is machine-readable in `test/product-invariants/registry.json`; full metadata remains in `docs/architecture/product-invariant-testing.md`. |
| Embedded provenance record matches shipped bits | 🔒 locked | Prune runs **before** `record-provenance.mjs embed`, so the sentinel's record describes the post-prune tree (verified end-to-end: 188 files, 0 mismatch). Behavior test `snProvEmbedBehavior` pins workspace-independence + the `!provenance.json` allowlist line. |
| Provenance **sentinel** (dogfood) vs governed **release boundary** (product) | 🔒 separated | Split into t-d0fc4f (dogfood: Tachyon hashes its own install; honest "unverified build" wording, never "tamper-proof") and t-a1faec (product: artifact provenance as evidence + brokered outward actions). The asymmetry is documented in both: a user project's root of trust lives off-machine; ours cannot. |
| `verify_task` has no implicit npm, Vitest, `test/unit`, full-suite or affected-test command | 🔒 locked | Full and changed-file commands run only from explicit `settings.verify.full` / `settings.verify.affected`; a named behavior test requires an explicit project adapter plus a pre-existing tracked project oracle whose hash is fixed at spawn, while `cmd:` remains runner-neutral and stub-free. BASE/HEAD evidence runs in isolated tracked-only clones. `test/unit/snBoundaryLocksBehavior.gen.test.ts` and the focused verification/config tests pin the absence of product defaults; Tachyon's own `tachyon.yml` opts into its repository commands. |
| `contributes.configuration` defaults carry no Tachyon-repo assumptions | 🔒 locked | `test/unit/snBoundaryLocksBehavior.gen.test.ts` reads `package.json`'s `contributes.configuration.properties` and asserts no default matches a Tachyon-build marker list (kept in the test, pointing back here). |
| `Tachyon: Init` scaffolds from the USER's stack (multi-ecosystem detection) | 🔒 locked | Detects `package.json`/`composer.json`/`Cargo.toml`/`go.mod`/`pyproject.toml`/`requirements.txt`/`Gemfile`. `test/unit/snBoundaryLocksBehavior.gen.test.ts` asserts the generated `tachyon.yml` carries no Tachyon-build markers for a non-npm (Cargo.toml) and a plain npm fixture. |
| `tachyon.yml` in this repo is dogfood fleet config living inside the product repo | 🟡 open | Discussed 2026-07-10: the file also carries `settings.verify` (tamper-evident only while tracked). Candidate design: `tachyon.local.yml` overlay (needs `CONFIG_FILENAMES` + merge support) keeping the versioned file canonical. |
| tmux server lifetime is independent of the engine unit (agents survive Reload) | 🔒 locked | Server-creating tmux commands launch via `systemd-run --user --scope --collect` so the forked server lands in its own `tachyon-tmux-*.scope`, not the engine unit's KillMode=control-group cgroup (t-3da510; the "all agents stopped after every Reload" failure). `test/unit/tmuxServerScope.test.ts` pins the wrap argv, the fail-open path, and — live where user systemd exists — forks a real server on a private socket and asserts its cgroup is a `tachyon-tmux-*` scope distinct from the caller's. |
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
