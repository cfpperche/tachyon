# 226 — tachyon-isolated-harness — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Step 1 — capability research — DONE (2026-06-16)
- [x] Verify claude isolation levers live (`CLAUDE_CONFIG_DIR`, `--mcp-config`, `--strict-mcp-config`,
      `--plugin-dir`, `--add-dir`, `--bare`, `--settings`) — see notes.md.
- [x] Verify codex isolation levers live (`CODEX_HOME`, `-c mcp_servers.*`, `-p profile`, `codex mcp`).
- [x] Confirm the primitive maps onto the existing per-agent `env:` + per-runtime adapter abstraction.
- [x] Capture the loop-engineering (`p-bf1d7d`) building-block tie-in.

## Step 2 — lock decisions — DONE (2026-06-16)
- [x] Decisions 0-6 locked (name="isolated harness"; v1 claude-only mcp-only; inherit default
      `workspace`; config-home materialization; `${ENV}`-only secrets + gitignore; worktree orthogonal;
      template framing deferred). See spec.md § Decisions.
- [x] codex design debate on the locked MVP → **CHANGES** (2 BLOCKER + 7 MAJOR; see notes.md).
- [x] **Decision 3 confirmed (config-home STANDS, no pivot)** — the 2 BLOCKERs verified live + proven
      bounded: auth = symlink `.credentials.json` (TEST B → AUTHOK); resume = thread the effective home.
      Flag-overlay rejected (wouldn't extend to the full harness). See notes.md § BLOCKER verification.
- [x] **Pre-impl live check (H7) — DONE.** claude expands `${VAR}` from the process env in both `args`
      and the server `env` block (marker test, notes.md § H7). Materialized `.mcp.json` carries `${VAR}`
      literally; the real var rides the existing `AgentDef.env` threading.

## Step 3 — implementation (claude-only mcp-only MVP) — DONE 2026-06-16. Each task cites its hardening req.
- [x] **Schema/validate (H9, H4, H7)** — `AgentDef.harness` + `parseHarness` in `loadConfig.ts`
      (+`AGENT_KEYS`); fail-closed on terminal/non-claude/`inherit:global`/empty-bad-`mcp`/literal-secret/
      `skills|rules|hooks`; rejects a `cmd` owning the flags or `env.CLAUDE_CONFIG_DIR`; `${VAR}`-only env.
      Mirrored in `tachyon.schema.json`.
- [x] **Materialization (H1, H6, H7)** — `src/harness/HarnessManager.ts`: `.credentials.json` symlink
      (unlinkSync — broken-symlink gotcha), `inherit` copy/overlay of workspace `.mcp.json`, `${VAR}` literal.
- [x] **Adapter capability** — `adapter.harness` shape + `harnessable()` (claude: `CLAUDE_CONFIG_DIR` +
      `--mcp-config`/`--strict-mcp-config`), gated per-runtime like `forkCommand`/`forkable`.
- [x] **Shared pipeline (H3)** — `AgentManager.applyHarness` on spawn/restart/resume; fork of a harness
      agent blocked in v1 (fail-closed).
- [x] **Resume-home threading (H2)** — `claudeConfigHome`; `transcriptPath` takes the config home; threaded
      through resolvers (`claudeHome` override) + readiness + refreshOwnership + resume; Workspace forwards it.
- [x] **GC (H8)** — `Workspace.gcHarnessHomes()` startup sweep; `.tachyon/harness/` gitignored.
- [x] **Tree affordance** — `-harness` segment in `contextValue.ts` builder + ⚙ badge/tooltip in Sidebar.
- [x] **Docs** — README "Isolated harness" section with the per-runtime support note.

## Step 4 — follow pass (after MVP proven)
- [ ] codex `CODEX_HOME` materialization (+ its own auth/resume threading audit).
- [ ] `skills` / `rules` / `hooks` overlays; `inherit: global` (these are why config-home was kept —
      they extend by writing more into the same home).
- [ ] (maybe) shared `harness-templates:`/`extends:` a schedule/routine can spawn (Decision 6, v2, rule-of-three).

## Tests — DONE (549 unit + typecheck + build green; `env -u TMUX npx vitest run`)
- [x] **Schema/validate** (config.test.ts, 11) — valid forms; rejects bad `inherit`, literal secret,
      conflicting `cmd` flags / user `CLAUDE_CONFIG_DIR` (H4), non-claude runtime, not-yet-built keys (H9).
- [x] **Materialization** (harness.test.ts, 13) — config-home shape; `.credentials.json` symlink (H1);
      `inherit:none` vs `workspace` snapshot (H5b/H6); `${VAR}` written literally not resolved (H7);
      stale-symlink rematerialize; remove()/list() for GC.
- [x] **No-leak (H5a) / Pipeline (H3)** (agentManager.test.ts) — non-harness agent gets no harness args;
      spawn + resume of a harness agent carry `CLAUDE_CONFIG_DIR` + `--strict-mcp-config`.
- [x] **Resume (H2)** (agentManager.test.ts) — resolver + transcript check scoped to the harness config home.
- [x] **Fork-block (v1)** (agentManager.test.ts) — forking a harness agent is refused (fail-closed).
- [x] **GC (H8)** (init.test.ts) — `.tachyon/harness/` gitignored; ownerless-sweep logic in Workspace.
- [x] **contextValue badge** (contextValue.test.ts) — 192-combo round-trip + menu-contract guard.
- [ ] **contextValue badge** round-trips (the 0.21.3 menu-contract-guard pattern).
