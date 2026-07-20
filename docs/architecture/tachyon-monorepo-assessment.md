# Assessment: monorepoizing the Tachyon ADE repo

_Status: product/engineering assessment (not an active migration program)._  
_Recorded 2026-07-20 from maintainer + agent discussion (browser/mobile companion packaging)._  
_Board task: `t-e4348c` (design, inbox)._

## Context

While designing the **Browser User Companion** (SDD `docs/specs/414-browser-user-companion/`, task `t-dec8a9`), we ratified:

1. **ADE (`cfpperche/tachyon`)** keeps owning engine, Bridge, VS Code shell, pairing server, `protocolVersion`.
2. **External shells** live in a **separate classic monorepo** `cfpperche/tachyon-companion` (apps: browser now, mobile next; shared client packages).
3. That raises the question: **should `tachyon` itself become a classic monorepo** (workspaces + packages)?

This document is the assessment of difficulty, value, and recommended sequencing. It is **not** a commitment to start the migration.

## Current shape of `cfpperche/tachyon`

| Aspect | Today |
|---|---|
| Form | **Single-package repo** — one root `package.json`, one version (`0.56.x`), one VSIX |
| Layout | Flat `src/*` (~500+ TS files); no `packages/`, no npm/pnpm workspaces, no turbo/nx |
| Build | `esbuild.mjs` already multi-entrypoint (`extension.js`, `engine-daemon.cjs`, webviews, resolvers, …) |
| Design boundary | Spec 382: engine must not know VS Code; shell is an adapter (`EngineHost` / control protocol) |
| `vscode` coupling | ~30 files import `vscode` (mostly `src/webview/*` + `extension.ts`); engine/bridge/agents ≈ 0 |
| Gates | `verify:full`, provenance, stable/dev channels, dogfood, Product Invariants, dev-host — all assume **repo root + flat `dist/`** |

So: Tachyon is already a **multi-artifact single package**, not a classic monorepo. “Monorepoize” means formalizing packages and workspace tooling on top of packaging/CI/version machinery.

## What “classic monorepo” would mean here

Illustrative target:

```text
tachyon/
  apps/
    vscode-extension/       # contributes, main, vsce
  packages/
    engine/                 # daemon, Workspace, Bridge, Delivery…
    protocol/               # control / companion pairing types
    webview-ui/             # optional
    shared/
  package.json              # workspaces root
```

Two very different difficulty grades:

| Grade | Meaning | Difficulty |
|---|---|---|
| **1 — Organizational monorepo** | Internal packages; **one version**; **one VSIX** at the end | Medium–high |
| **2 — Independent products** | Engine and shell versioned/released separately | Very high |

Most of the design value is Grade 1. Grade 2 is a separate productization program.

## Difficulty by layer

### Easy / already mostly true
- Mental split engine vs shell (engine avoids `vscode`).
- Multi-entrypoint bundling.
- Headless unit tests for bridge/agents without UI.

### Medium — code move + imports
- Split `src/` into packages with `exports`.
- Rewrite relative imports to workspace names.
- `tsconfig` project references (root / webview / browser-test today).
- Vitest roots, aliases, setups.
- Scripts (`verify-full`, provenance, dev-host, dogfood) hard-code root + flat `dist/`.

Order of magnitude: **~2–6 weeks** of careful engineering if the suite must stay green (not a cosmetic PR).

### Hard — VS Code / VSIX packaging
Today assumes:
- Root `package.json` **is** the extension (`main`, `contributes`, `activationEvents`).
- `vsce package` at repo root.
- `dist/extension.js` + `dist/engine/*` + webviews in one layout.
- Provenance / channel / deploy identity bound to that root package.

Moving the extension manifest under `apps/vscode-extension/` forces rewrites of `.vscodeignore`, prepare-package, provenance, F5/dev-host, worktree dogfood paths. **vsce + monorepos is a known pain surface.**

### Hard — versioning and release identity
Today: **one version** = engine + shell + schema.  
Independent package versions need compat matrix (`protocol.min/max` on the engine manifest is a good seed), multi-package changelog, and mixed-version dogfood. Process cost dominates code cost.

### Medium–high — CI and product gates
`verify:full` lock, worker caps, affected tests, PI import graph, worktrees, `npm ci` at root, self-hosting `tachyon.yml` — all treat the **whole repo** as the unit. Packages need “what builds when X changes” rules.

### Low value — putting companion apps inside this monorepo
Browser/mobile store release cycles, privacy review, and CI must **not** share the ADE full-suite gate. That is why **`tachyon-companion` is a separate monorepo**.

## Effort sketch (order of magnitude)

| Goal | Difficulty | Effort | Risk |
|---|---|---|---|
| Do nothing — keep single-package ADE; companion monorepo elsewhere | — | 0 | None |
| Folder hygiene only (`src/engine` vs shell, no workspaces) | Low | Days | Low |
| Workspaces + packages, one VSIX, one version | Medium–high | ~2–6 weeks | Medium (CI/pack) |
| Clean vsce layout + mature multi-package CI/docs | High | ~1–2 months with interruptions | High if parallel feature work |
| Independent engine/shell versioning | Very high | Quarter+ of process maturity | High (compat matrix) |

## When monorepoizing *this* repo is justified

Good reasons:
1. Publish / test **headless engine** without loading VS Code.
2. A second in-tree shell (CLI) depends on `@tachyon/engine` without forking.
3. Compile-time package boundaries (fail closed if shell imports wrong internals).

**Not** a good reason: “so the browser extension can live here.” That is `tachyon-companion`.

## Recommended sequencing (if ever started)

1. **Do not** block companion work on ADE monorepo migration.
2. Optional small win: extract a **`protocol` surface** (types/schema + `protocolVersion`) that companion clients can mirror — can start as docs/schema under ADE without full workspaces.
3. Only later: `@tachyon/engine` + `apps/vscode-extension` with **lockstep version** and single VSIX bundle.
4. Independent versioning only when a second shell truly requires it.

## Explicit non-goals of this assessment task

- Starting the migration in the same breath as companion v1.
- Merging `tachyon-companion` into `tachyon`.
- Changing Product Invariants as part of a structural move (any PI impact would need its own governance when implementation starts).

## Related artifacts

| Artifact | Role |
|---|---|
| `docs/system-design.md` | Engine/shell split living design |
| Spec 382 (persistent engine/shell boundary) | Shipped boundary that makes packages *feasible* |
| `docs/specs/414-browser-user-companion/` | Companion product seed; hybrid repo strategy |
| `t-dec8a9` | Design task for Browser User Companion |
| Future `cfpperche/tachyon-companion` | Classic monorepo for browser + mobile companions |

## Suggested acceptance for the *implementation* program (later)

When a maintainer promotes this from assessment to active work, a real SDD should replace this note. Sketch gates:

- [ ] Workspace root builds all packages; extension package still produces one VSIX with engine embedded as today (Grade 1).
- [ ] `npm run typecheck` and `npm run verify:full:quiet` green from root with documented package graph.
- [ ] Engine package has zero `vscode` imports (mechanical check).
- [ ] Dev Host / F5 / provenance / stable channel still work without dual identity bugs.
- [ ] No companion apps in this monorepo.

## One-line summary

**Difficulty is medium–high for a real workspaces monorepo with a clean VSIX; low for folder-only hygiene; unnecessary as a prerequisite for companion.** The expensive part is packaging, CI, and release identity — not inventing an engine/shell split (that already exists).
