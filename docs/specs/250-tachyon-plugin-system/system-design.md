# Spec 250 — System Design: the Tachyon multi-runtime plugin system (v1)

_Agreed 2026-06-22 (maintainer + Claude Code ↔ Codex duetos). This is the consolidated v1 skeleton after the maintainer simplified away the abstraction layer. The spec.md holds the decision history + dueto findings; THIS file is the design to build from._

## 1. Core model (no abstraction — parity)

> A Tachyon plugin is an **aggregate of the runtimes' OWN native config/capabilities**, bundled with a manifest. It carries, **per supported runtime, that runtime's config in that runtime's native format** — at parity with the runtime. There is **no cross-runtime abstraction**: runtimes never reach 100% parity, so a Tachyon plugin does not invent a portable middle layer — it ships each runtime's block natively and declares which runtimes it supports. If a runtime's config format evolves, the plugin's block for it evolves with it.

A Tachyon plugin **depends on Tachyon** (Tachyon installs / updates / removes it; v2 plugins also bind Tachyon engine features). It is **persisted in the workspace** — **committed by default**, `.gitignore`-able by user choice. Tachyon is the installer/manager; the materialized runtime blocks then run **natively** in each runtime.

## 2. Plugin structure (v1)

```
sdd-plugin/
  tachyon-plugin.json        # manifest
  claude/                    # OUR claude-native layout (CC-plugin-INSPIRED, NOT CC-format-as-is)
    hooks.json               #   claude hook decls (PreToolUse/PostToolUse/… — claude's events)
    skills/sdd/SKILL.md      #   claude skill
    mcp.json                 #   claude MCP server decl
  codex/                     # codex-native layout
    hooks.json               #   codex hook decls (apply_patch matcher, JSON output — codex's surface)
    ...                      #   (a capability absent for codex simply has no codex/ entry → unsupported there)
  shared/                    # scripts referenced by >1 runtime block; portability is the AUTHOR's job
    delegation-gate.sh       #   (e.g. a hook script that branches on the runtime's payload shape)
```

- **No `tachyon/` engine-bindings folder in v1** — deferred to v2 (runbooks / pipeline templates / Bridge tools / activity renderers as plugins).
- A block is present ⇔ the plugin supports that runtime. The `claude/` and `codex/` layouts are **our own** (inspired by the Claude Code plugin shape, but not CC-format so we're not coupled to CC's schema).

## 3. Manifest (`tachyon-plugin.json`)

```jsonc
{
  "name": "sdd",
  "version": "1.2.0",
  "description": "Spec-driven development scaffolding",
  "runtimes": ["claude", "codex"],          // what THIS plugin supports (v1: claude|codex)
  "dependencies": ["some-base-plugin@^1"],   // optional: other plugins this one needs (§7)
  "blocks": {
    "claude": "claude/",                     // path to each runtime's native block
    "codex":  "codex/"
  }
  // no abstract events, no per-capability runtime list — the block IS the runtime's native config
}
```

## 4. Components

```
┌──────────────────────────────────────────────────────────┐
│ Plugins View (extension UI)                                │
│   browse marketplace · per-runtime compat · install/upd/rm │
├──────────────────────────────────────────────────────────┤
│ Security/Trust layer (BLOCKING in v1)                      │
│   provenance · permission summary · hook/MCP DIFF PREVIEW  │
│   · dangerous-disabled-by-default · no silent remote enable│
├──────────────────────────────────────────────────────────┤
│ Materialization Engine        │ Updater (3-way merge)      │
│   per declared+present runtime │  baseline vs new vs user   │
│   → call that runtime's adapter│  (sync-harness reused)     │
├──────────────────────────────────────────────────────────┤
│ Per-runtime Adapters (v1: claude, codex)                   │
│   merge the native block INTO the runtime's workspace cfg  │
│   · knows WHERE that cfg lives + HOW to merge/un-merge      │
│   · materialize() / unmaterialize() / diff()  [idempotent] │
│   NO transformation — copy/merge native config only        │
├──────────────────────────────────────────────────────────┤
│ Manifest layer       │ Source/Marketplace layer            │
│   parse/validate ·    │  git / github / path → cache ·      │
│   resolve deps ·      │  integrity · marketplace.json       │
│   compat = runtimes ∩ ws-present                            │
└──────────────────────────────────────────────────────────┘
        ↓ writes real files into the workspace ↓
  .claude/{settings.json,skills/,…}  ·  .codex/{hooks.json,…}
  ·  the plugin payload (committed by default)  ·  lockfile
```

**The adapter is deliberately dumb-but-precise:** it does NOT transform an abstraction — it merges a runtime's *native* block into that runtime's *native* config location, idempotently, and can un-merge exactly what it wrote. Per-runtime knowledge = just "where does this runtime's config live + how do I merge/un-merge it" (the parity).

## 5. Flows

- **Install:** resolve source → cache + integrity → compat (`manifest.runtimes` ∩ workspace-present runtimes) → **trust prompt + diff preview** → for each compatible runtime, adapter merges its block into the workspace → write lockfile. Persist payload (committed by default).
- **Update:** re-resolve (plugin or runtime-format bumped) → **3-way merge** (baseline = last materialized, new = update, current = user edits) → clean auto-applies, conflict refuses without `--force` → preview → apply.
- **Remove:** read `materializedTargets` from lockfile → adapter un-merges **exactly** what it wrote (idempotent; never touches user edits).

## 6. State / persistence

- **Committed by default** — the materialized runtime config + payload go into the repo, so a teammate inherits on clone (and the runtime blocks work natively even without Tachyon running; Tachyon is needed for install/update/remove and, in v2, engine-bound parts).
- **`.gitignore`-able by choice** — a user who wants a clean repo can gitignore the managed area; then re-install needs Tachyon. (The old "must work without Tachyon" goal is dropped — a Tachyon plugin legitimately depends on Tachyon.)
- **Lockfile** `tachyon-plugins.lock.json` (committed): per plugin → version, source, resolvedCommit, integrity, enabled runtimes, `materializedTargets` (the exact uninstall set), adapter versions.

## 7. Bundle / meta-plugin (CONTENT, not engine — out of v1)

If a set of capabilities is genuinely coupled, a **bundle plugin** (a plugin whose only content is `dependencies: [...]`) can group them so they install together — installing it pulls its dependencies. This is **content** that lives in a plugin repo, NOT engine work: the engine already validates `dependencies` in the manifest (Step 1). Building any concrete bundle is a later, demand-gated, content decision — the Tachyon repo ships no plugins.

## 8. v1 scope vs deferred

| v1 | Deferred (v2+) |
|---|---|
| runtime blocks only (claude + codex) | **engine-bindings** (`tachyon/`: runbooks, pipeline templates, Bridge tools, activity renderers) |
| own claude/codex native layouts | **gemini** adapter |
| manifest + lockfile + `dependencies` resolution | gitignored-payload + external-store (p-16058c) |
| marketplace/source sourcing (git/path) | visual builder (p-5e0ff3) · monetization (p-45a846) |
| install / update / remove · uninstall first-class | agent-authored plugins (p-54cdb8) |
| security/trust + diff preview · committed default | concrete bundle plugins (content, not engine) |

## 9. Security model (v1, BLOCKING)

Installing a plugin wires hooks (arbitrary shell on runtime events) + MCP servers from a source. Before any materialization: source **provenance**, a **permission summary**, a **diff preview** of every file/config write, explicit consent, **dangerous hooks disabled-by-default**, pinned/signed source where possible, a per-workspace trust boundary. **No silent auto-enable from a remote marketplace.**

## 10. Build order (proposed)

1. Manifest schema + parser/validate + compat resolution (pure, unit-tested). ✅ shipped
2. `claude-adapter` merge/un-merge + lockfile (idempotent; the one-runtime path end-to-end). ✅ shipped
3. Materialization engine + install/remove + security diff preview (real claude workspace smoke). ✅ shipped
4. `codex-adapter` + engine multi-runtime generalization (proves the thesis on a 2nd runtime). ✅ shipped
5. **Pure infra, no content:** updater (3-way merge — update an installed plugin without clobbering edits) + sourcing (where plugins come from: a local path / git / marketplace, since the engine today loads from a dir) + the **Plugins View** (extension UI: browse → install/update/remove). No bundled plugins.
