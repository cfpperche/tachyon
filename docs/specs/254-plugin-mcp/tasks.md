# Spec 254 — Plugin MCP — tasks

**Status:** DRAFT — tasks are deliberately not broken down yet. Design is proposed (D1–D8) with six open questions (OQ1–OQ6); per the per-step codex-dueto discipline, the spec is debated with codex and signed off by the maintainer BEFORE task decomposition. Decisions get folded into `spec.md`; the implementation plan then mirrors spec 251's step shape:

1. Manifest/payload: load + validate the neutral MCP declaration (fail-closed; resolves OQ1/OQ2).
2. Engine: `planMcpTargets` + extend `previewInstall`/`applyInstall` for the `mcp-server` `TargetKind`, with Keep/Replace decisions (mirror `planSkillTargets`).
3. Adapters: claude `.mcp.json` + codex `.codex/config.toml` MCP writers, sharing ONE server-name-generic helper lifted from `registration/adapters.ts` (D6).
4. Consent: drawer MCP section (transport, command/url, env refs, destination) + per-collision Keep/Replace.
5. Tests: engine units (install/skip, stdio+http, Keep/Replace, fail-closed, content-preserving remove) + Bridge regression + UI via the real built bundle.

**Verify:** `npm run typecheck && npm run check:engine-boundary && npx vitest run`
