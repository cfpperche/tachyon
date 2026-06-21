# Plan 240 — `isolate: transcript`

## Architecture

```
tachyon.yml: agents.<name>.isolate: transcript
        │  parse (loadConfig) → AgentDef.isolate
        ▼
claudeConfigHome(name, def): def.harness OR def.isolate==="transcript" → harnessHome(ws, name); else ~/.claude
        │
        ├─ spawn/restart/resume augmentation → materialize PRIVATE HOME ONLY:
        │     symlink .credentials.json + seed .claude.json markers   (NO --mcp-config / --strict-mcp-config)
        │     env: { CLAUDE_CONFIG_DIR: home }   args: []
        │
        ├─ ledger record gains resume.configHome = home   (drift fix, D4)
        ▼
ambiguity bucket = (canonical cwd, effective configHome)   →   refreshOwnership + transcriptPathOf
        ▼
isolated agent on a shared cwd is UNAMBIGUOUS → newest-by-cwd within its home follows in-TUI /resume,
attribution works, the spec-239 writer logs it.
```

## Components

### 1. Config (`loadConfig.ts`)
- `AgentDef.isolate?: "transcript"` (scalar enum). Parse + validate:
  - claude-only (reject non-claude with a clear error, like `harness:`).
  - reject on terminals.
  - reject if `env.CLAUDE_CONFIG_DIR` is set (Tachyon owns the home).
  - `harness:` already implies an isolated home → `isolate: transcript` on a harness agent is redundant (warn or no-op; harness wins).

### 2. Home-only materialization (refactor `HarnessManager`)
- Extract the private-home seeding (`harnessHome` + symlink `.credentials.json` + seed `.claude.json` markers + per-cwd trust) out of `materialize()` into a `materializeHome(agent)` helper.
- `materialize()` (full harness) = `materializeHome` + the MCP/skills/rules/settings + strict-mcp args.
- transcript-only = `materializeHome` + `{ env: { CLAUDE_CONFIG_DIR: home }, args: [] }`.
- Logged-out real home → the existing honest `HarnessUnavailableError`.
- **Regression guard (the refactor must NOT change `harness:`):** identical private-home path (`harnessHome`), identical `.credentials.json` symlink, identical `.claude.json` onboarding/trust seeding, identical logged-out error — and full harness STILL gets its MCP/skills/rules/settings + `--strict-mcp-config`/`--mcp-config` args. A test pins `materialize()` output (env + args) unchanged for a harness agent.

### 3. `claudeConfigHome` (AgentManager)
```
private claudeConfigHome(name, def):
  if (def?.harness || def?.isolate === "transcript") return harnessHome(workspaceRoot, name);
  return ~/.claude;
```

### 4. Effective-home resolution + drift-fix INVARIANT (D4 — codex HIGH)
- `SessionResume` gains `configHome?: string`.
- **Preserve-or-set on EVERY write**: every `ledger.record(...)` call site (spawn, resume, refreshOwnership, capture-upgrade) must carry `configHome` forward — never write a row that drops it. New rows set the ACTUAL augmentation home used for the spawn.
- **Backfill once on load**: `SessionLedger.all()` (or a one-shot migration on first touch) fills a missing `configHome` with the derived `claudeConfigHome(name, def)`, so old rows stop drifting immediately.
- **Lookup**: `transcriptPathOf` + `refreshOwnership` use `record.resume.configHome ?? claudeConfigHome(name, def)`.
- **GC keep-set**: `gcHarnessHomes` must treat any `resume.configHome` present in the ledger as LIVE (never reap a home a row still points at).

### 5. Ambiguity bucket (D3)
- A helper `bucketOf(rec, name) = { cwd: resolve(rec.cwd), home: effectiveHome(rec, name) }`.
- Both predicates: a peer is ambiguous only if `bucketOf(peer) deepEquals bucketOf(self)` — i.e. same cwd AND same home. Isolated agents differ by home → not ambiguous.

### 6. Lifecycle / GC (D5)
- Home created lazily at spawn/restart/resume via the augmentation point (same as harness).
- NEVER removed on Stop. **Delete does NOT force-delete the home inline** — it removes the ledger row (spec 239), which makes the home OWNERLESS; the next startup `gcHarnessHomes` reaps it (when the agent is neither declared, ledger-tracked, NOR referenced by a `resume.configHome` — the D4 keep-set). Matches the existing harness-home lifecycle (the transcript is retained until a clean ownerless GC, never yanked mid-flight).

## Sequencing → increments
1. **Config + parse**: `AgentDef.isolate` enum + validation (claude-only, no terminal, no manual CLAUDE_CONFIG_DIR). Tests.
2. **Home-only materialize**: refactor `materializeHome` out of `materialize()`; wire `claudeConfigHome` for `isolate`; spawn injects `CLAUDE_CONFIG_DIR` (args:[]) + the harness regression-guard test. Tests (env + auth symlink, no mcp args). **NOTE: same-cwd activity logging is NOT yet correct after inc 2 alone** — the cwd-only ambiguity check still suppresses it until inc 3.
3. **Drift fix + ambiguity bucket**: the D4 invariant (persist + preserve-on-write + backfill-once + GC keep-set); both predicates compare `(cwd, effective home)`. This is what actually makes same-cwd isolated logging + in-TUI follow work. Tests (isolated same-cwd unambiguous; plain same-cwd still suppressed; old-row backfill; stale-write doesn't drop configHome; GC doesn't reap a referenced home).
4. **Lifecycle/GC + worktree compose**: confirm reap on delete/GC; worktree+isolate. Tests.

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run`
**UI impact:** none (config + host plumbing; the spec-239 Activity view consumes the result unchanged).
