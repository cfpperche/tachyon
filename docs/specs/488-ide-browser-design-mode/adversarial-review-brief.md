# Adversarial review brief — SDD 488 + Design Mode prototype

**Requested by:** grok (via human)  
**Date:** 2026-08-04  
**Reviewer:** codex  
**Branch / tree:** `tachyon/grok` at  
`/home/goat/.cache/tachyon/worktrees/b349073a/grok`  
**Outcome:** `review-codex.md` written (rework-before-merge posture on security). Product later
chose pragmatic path; see `notes.md` + `architecture-fit.md` for merge-review framing.

## Mission

Perform an **adversarial review** of:

1. **Formal product SDD 488** — `docs/specs/488-ide-browser-design-mode/{spec,plan,tasks,notes}.md`
2. **Prototype codebase** on this branch for Integrated Browser + Design Mode (uncommitted + committed)

Assume the authors are wrong. Find holes, overclaims, security issues, race conditions, product contradictions, test gaps, and places where the code does not match the spec (or the spec does not match reality).

## Code / surface map (start here)

### Spec
- `docs/specs/488-ide-browser-design-mode/spec.md`
- `docs/specs/488-ide-browser-design-mode/plan.md`
- `docs/specs/488-ide-browser-design-mode/tasks.md`
- `docs/specs/488-ide-browser-design-mode/notes.md`

### Shell (extension host)
- `src/webview/ide-browser-bridge/manager.ts` — HTTP bridge, start/stop, chat, attention poll, `bridge.refresh-tools`
- `src/webview/ide-browser-bridge/designModeInject.ts` — in-page UI inject
- `src/webview/ide-browser-bridge/designModeChat.ts` — JSONL store + prompt format
- `src/webview/ide-browser-bridge/cdpSession.ts`, `pick.ts`, `register.ts`

### Engine client
- `src/ide-browser/client.ts` — discovery, PID sweep, request
- `src/ide-browser/protocol.ts` (if present)

### Bridge / MCP
- `src/bridge/tools.ts` — `ide_browser_*`, `design_mode_chat_reply` (always-register change)
- `src/bridge/Bridge.ts` — `forceToolListRefresh`
- `src/workspace/Workspace.ts` — deps wiring
- `src/runtime-api/extensionOperations.ts` — `bridge.refresh-tools`
- `src/engine-service/extensionOperationService.ts`

### Related / adjacent on branch (in scope if they affect Design Mode reliability)
- `src/bridge/agentTokenHeal.ts`, `callerIdentity.ts` — auth/token dogfood path
- `test/fixtures/ide-browser-dogfood/`
- unit tests: `test/unit/designModeChat.test.ts`, `designModeInject.test.ts`, `ideBrowserClient.test.ts`, …

### Useful git commands (from repo root above)
```bash
cd /home/goat/.cache/tachyon/worktrees/b349073a/grok
git status -sb
git diff --stat HEAD
git log -5 --oneline
```

## Review lenses (required)

Attack each of these explicitly:

### A. Spec quality
- Acceptance criteria testable? Overclaims vs non-goals?
- F1–F10 follow-ups: missing threats? Fake deferrals hiding v1 blockers?
- Three-browser matrix (agent-browser / Companion / Design Mode) coherent with 414/420/267?
- Dogfood-Opt-Out honest or hand-wavy?
- Status `draft` appropriate given how much code already exists?

### B. Architecture honesty
- Two-bridge model: failure modes, identity, token, port races
- Instance file discovery + dead PID sweep: TOCTOU, multi-root, HOME rewrite
- MCP session freeze vs `forceToolListRefresh` (does it actually re-register tools?)
- Always-register offline tools: list pollution, runtime behavior if tool fails

### C. Security
- `ide_browser_eval` / click / navigate trust model
- HTTP token on loopback: file permissions, token leakage in logs
- CDP inject + Trusted Types: XSS / page takeover
- Chat JSONL path traversal or prompt injection into agent
- Authz: any agent can post as any `agent` name on `design_mode_chat_reply`?

### D. Product / UX loop
- Pick → agent → reply reliability
- Markers fallback vs tool path (Codex was observed listing the tool and not calling it)
- Multi-agent UI vs single-agent v1 contradiction
- Working/typing false positives; hydrate races

### E. Implementation quality
- Error handling, race on start/stop, leak of timers/HTTP servers
- Test coverage vs risk
- Dead code / unfinished paths marked as done in tasks.md
- Spec/code drift: tasks marked `[x]` that aren’t true on disk

### F. Ship risk
- What would break if this merged to main tomorrow?
- Minimum bar before dogfood gate should pass
- Top 5 blockers ranked by severity

## Deliverable

Write **`docs/specs/488-ide-browser-design-mode/review-codex.md`** with:

1. **Verdict** (1 paragraph): ship / ship-with-fixes / rework / reject-as-product
2. **Findings** table: `id | severity (P0–P3) | area | claim | evidence (file:line or quote) | recommendation`
3. **Spec vs code drift** list
4. **Top 5 blockers** before any merge discussion
5. **What is solid** (keep) — short, honest
6. **Optional:** suggested acceptance criteria rewrites (only if broken)

Constraints:
- Do **not** merge to main
- Do **not** expand feature scope; review only
- Prefer evidence over vibes; cite paths/lines
- When done, stop with a short terminal summary + path to `review-codex.md`
