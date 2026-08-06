# 488 — ide-browser-design-mode — tasks

_Generated from `plan.md` on 2026-08-04. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

**Branch rule:** implement on `tachyon/grok` (or successor feature branch). **Do not merge to `main`** until maintainer ratify + dogfood gate (spec F10).

## Phase 0 — Contract + catalog reliability

- [x] Scaffold SDD `docs/specs/488-ide-browser-design-mode/` (`spec` / `plan` / `tasks` / `notes`)
- [x] Document three-browser product matrix and two-bridge architecture in `spec.md`
- [x] Document follow-ups F1–F10 in `spec.md` (not silent backlog)
- [x] Always-register `ide_browser_*` + `design_mode_chat_reply` when `ideBrowserRequest` is wired (`src/bridge/tools.ts`)
- [x] `bridge.refresh-tools` extension command exists (kept for settings-like catalog flips; **not** used on IDE browser start/stop)
- [x] IDE Browser Bridge `start`/`stop` does **not** force MCP session kill (`manager.ts` 2026-08-04)
- [x] Unit test: tools register without a live instance file (mock deps with `ideBrowserRequest` only) — `test/unit/ideBrowserToolsOffline.test.ts` (t-3cab05)
- [x] Unit test: offline call returns actionable error envelope (not missing tool) — matches F3 stream text (t-3cab05)
- [x] Confirm `isIdeBrowserBridgeAvailable` remains a **status** probe, not a registration gate — same test file (t-3cab05)

## Phase 1 — Loop reliability (productize prototype)

- [x] Chat prompt is tool-only (no marker advertisement in `formatDmChatPrompt`)
- [x] UI single-agent copy + running agents only in selector
- [x] Ingest prefers active Design Mode agent (ignore mismatched speaker param)
- [ ] Pick path: active agent required; clear UI error if missing/stopped
- [ ] Chat send: append human event → format prompt (path + tool instruction only) → inject agent
- [ ] Ingest `design_mode_chat_reply` into JSONL + push to panel (no full-history re-prompt)
- [x] F3 runtime matrix (`t-dd46a4`, 2026-08-06): Claude 2.1.223 / Codex 0.146.0 / Grok 0.2.118 list+call under tool-only prompt; panel land unmeasured (IDE bridge offline); Pi unmeasured — see `notes.md` + `docs/research/design-mode-chat-reply-runtime-matrix-t-dd46a4.md`
- [ ] Attention-based working/typing UX (poll `attention.list` / agents; grace for tool latency)
- [ ] Hydrate chat on panel open from workspace store (not only live tail)
- [ ] Panel drag + resize stable; dropdown anchored to toolbar (no `position:fixed` under transform)
- [ ] Re-inject Design Mode UI after navigation / CDP reconnect
- [ ] Status-bar: adjacent icon cluster only (shared group name; no long dual labels)
- [x] Demote pane markers: prompt forbids markers; tool-only happy path

## Phase 2 — Dogfood gate

- [x] Fixture `test/fixtures/ide-browser-dogfood` clean (no pre-created agents unless scenario needs them)
- [x] Human dogfood: pick → chat attach → agent received selection (2026-08-04, notes.md)
- [ ] Record Evidence screenshots under `docs/specs/488-ide-browser-design-mode/evidence/` (optional for merge review)
- [x] Runtime matrix F3: Grok / Claude / Codex — tool listed? tool called? (`t-dd46a4` 2026-08-06; panel land still open — IDE bridge offline; Pi unmeasured)
- [x] README fixture steps updated (`test/fixtures/ide-browser-dogfood/README.md`)
- [ ] Maintainer ratify open questions Q1–Q5 + **architecture-fit.md** (two bridges keep vs rewrite)
- [x] Branch ready for merge **review** (no auto-merge; F10)

## Merge review package

- [x] SDD 488 + `architecture-fit.md` (two-bridge fit for codebase)
- [x] Unit tests: designModeChat / Inject / Pick / ideBrowserClient / agentTokenHeal / callerIdentity
- [ ] Maintainer review + decision on main

## Phase 3 — Follow-ups (do not block v1; track only)

_Start only after P2 green or explicit maintainer pull-forward. Prefer split SDD when large._

- [ ] **F1** Remove pane marker primary path after runtime matrix green
- [ ] **F2** Multi-agent group thread product rules + SDD or design task
- [ ] **F3** Runtime parity matrix living doc / notes table
- [ ] **F4** GA settings gate + onboarding copy
- [ ] **F5** Pick → structured edit quality
- [ ] **F6** Security review (eval, token, Trusted Types, click)
- [ ] **F7** `cookbook.md` via sdd-cookbook (operator: which browser product when)
- [ ] **F8** Visual QA pack for `/sdd close`
- [ ] **F9** Multi-root / multi-window instance edge cases
- [ ] **F10** Maintainer decision: merge feature branch → `main` (checklist, not automatic)

## Verification

_Acceptance checks tied to `spec.md`._

- [ ] Scenario A: bridge start + dead sweep + navigate/observe
- [ ] Scenario B: pick injects bounded work; missing agent fails clearly
- [ ] Scenario C: chat message → tool reply in panel; tools listed offline; refresh on start
- [ ] Scenario D: durable store; no full history in prompt; panel UX usable
- [ ] Scenario E: three-browser matrix documented; tool namespace distinct from Companion

**Headless check:** unit tests for design-mode chat + ide-browser client + tool registration

**Verify:** `npx vitest run test/unit/designModeChat.test.ts test/unit/ideBrowserClient.test.ts test/unit/designModeInject.test.ts`

## Dogfood

**Dogfood-Opt-Out:** full Integrated Browser + Design Mode loop requires VS Code Extension Development Host + editor-browser + live agent runtime; not meaningfully headless. Headless coverage is the **Verify** unit set above. Human dogfood checklist lives in `spec.md` § Dogfood contract.

**Human dogfood:** see `spec.md` § Dogfood contract (product gate sketch). Run on Extension Development Host against `test/fixtures/ide-browser-dogfood` (or equivalent clean workspace).

## Visual QA

_UI work — capture when dogfooding P2._

- [ ] Evidence: (add paths under `docs/specs/488-ide-browser-design-mode/evidence/` when screenshots land)
- [ ] Verdict:

## Cookbook

**Cookbook:** yes — after tool names stabilize (F7); scaffold with sdd-cookbook before GA.

<!-- Until F7: cookbook pending; close will warn if status=shipped without cookbook.md -->
