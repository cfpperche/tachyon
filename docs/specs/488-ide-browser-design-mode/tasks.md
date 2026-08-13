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
- [x] Remove the pane-text reply protocol; `design_mode_chat_reply` is the only path (`t-45b266`)

## Phase 2 — Dogfood gate

- [x] Fixture `test/fixtures/ide-browser-dogfood` clean (no pre-created agents unless scenario needs them)
- [x] Human dogfood: pick → chat attach → agent received selection (2026-08-04, notes.md)
- [x] Record Evidence screenshots under `docs/specs/488-ide-browser-design-mode/evidence/` (optional for merge review) — t-7f994f 2026-08-12
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

**Ordering, kill list and open decisions live in [`hybrid-d-path.md`](hybrid-d-path.md)** (`t-d49ef0`,
2026-08-07). Read it before picking one of these up: it re-scopes F1/F5/F7, folds `t-2b948e` into
`t-64edaf`, and names three task bodies whose premise has already drifted.

- [ ] **F1** Remove pane marker primary path after runtime matrix green
- [ ] **F2** Multi-agent group thread product rules + SDD or design task
- [ ] **F3** Runtime parity matrix living doc / notes table
- [x] **F4** GA settings gate + onboarding copy (`settings.ideBrowser.enabled` + first-use tips; tools still always-register) — t-48ff4a
- [ ] **F5** Pick → structured edit quality
- [ ] **F6** Security review (eval, token, Trusted Types, click)
- [x] **F7** `cookbook.md` via sdd-cookbook (operator: which browser product when) — t-26232e
- [x] **F8** Visual QA pack for `/sdd close` — t-7f994f 2026-08-12
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

_UI work — capture when dogfooding P2. F8 / t-7f994f 2026-08-12._

- [x] Evidence: `docs/specs/488-ide-browser-design-mode/evidence/design-mode-toolbar.png`
- [x] Evidence: `docs/specs/488-ide-browser-design-mode/evidence/pick-attach.png`
- [x] Evidence: `docs/specs/488-ide-browser-design-mode/evidence/chat-reply.png`
- [x] Evidence: `docs/specs/488-ide-browser-design-mode/evidence/status-bar-cluster.png`
- [x] Evidence: `docs/specs/488-ide-browser-design-mode/evidence/t-330a51-before.png`
- [x] Evidence: `docs/specs/488-ide-browser-design-mode/evidence/t-330a51-after.png`
- [x] Verdict: **pass** (t-330a51, 2026-08-12) — at 880×660 the Selection card sits left of the chat; the landed grok bubble is fully readable. Residual geometric overlap only below 748px width; at 360 the chat stacks above the card so the transcript stays hit-testable. Drag still moves the card. Same inject expression, same page, before/after pair.
- [x] Verdict: **concern** (pack complete; one layout defect filed, no UI fix in this pass). Real Extension Development Host captures on worktree `60f7ec21` via `headless-session` + fixture `ide-browser-dogfood` after t-47503a manager split. **Toolbar:** floating footer bar with agent selector (`grok` label), chat, picker (armed), viewport presets — readable, theme-token chrome. **Pick attach:** Selection card shows tag/id/text/styles/HTML; chat chip `Attached: <h1> hero` + "Attached to chat — type your ask there" — matches unified-channel intent. **Chat reply:** agent bubble lands in panel via production `/design-mode/chat-reply` host route (same door as `design_mode_chat_reply`); attributed to `grok`. **Status bar cluster:** adjacent globe + inspect icons (shared "Tachyon IDE" group); inspect uses warning/yellow background when Design Mode ON — exclusive priority band holds. **Issues found (not fixed here):** (1) with pick card + chat both open, the Selection panel covers the chat transcript so a landed reply is hidden until the card is closed — follow-up task. (2) fixture has empty agent roster yet toolbar/status still show agent label `grok` (default label, not a live agent). (3) first open briefly showed browser "Paused due to Notification" until first-use tips dismissed. **visual-qa skill:** web-only; Design Mode is VS Code shell + CDP inject — captured through Dev Host exploratory session instead. **Bytes added:** ~510 KiB PNG pack.

## Cookbook

**Cookbook:** yes — after tool names stabilize (F7); scaffold with sdd-cookbook before GA.

<!-- Until F7: cookbook pending; close will warn if status=shipped without cookbook.md -->
