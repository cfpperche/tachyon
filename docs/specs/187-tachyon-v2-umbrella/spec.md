# 187 — tachyon-v2-umbrella

_Created 2026-06-09._

**Status:** in-progress

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-09 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

**UI impact:** none

## Intent

Umbrella/tracking spec for Tachyon's post-v1 evolution (`packages/tachyon/`, shipped in spec 186). It holds the prioritized backlog from the 2026-06-09 gap analysis (HiveTerm parity + product maturity) and governs the follow-up discipline the user chose: **each item is opened as its own child spec, one at a time, discussed, and explicitly decided — implement, defer, or cancel.** This umbrella never carries implementation itself; it tracks decisions and links children. It closes when every backlog row has a decision state.

## Backlog (priority order)

| # | Item | Origin | Effort | Child spec | Decision |
|---|---|---|---|---|---|
| F1 | **Attention detection** — detect an agent waiting for human input (prompt/confirmation) and signal it (sidebar badge + notification) | HiveTerm parity; the core multi-agent value | M | 188-tachyon-attention-detection | **implemented** (shipped 2026-06-09, 6dbd6c9) |
| F2 | **Crash lifecycle** — exit-code visibility, death notification, `restart: on-crash` policy in `tachyon.yml` | HiveTerm parity (auto-restart/exit codes) | S/M | 190-tachyon-crash-lifecycle | **implemented** (shipped 2026-06-09, 6f3a053) |
| F3 | **Bridge auth token** — stable per-workspace Bearer token; close the "any local process can spawn agents" hole | Product hardening | S | 191-tachyon-bridge-auth | **implemented** (shipped 2026-06-10, a4756c0) |
| F4 | **Pins / notes** — shared checklist + whiteboard as workspace files; sidebar section + 5 Bridge tools | HiveTerm parity | M | 192-tachyon-pins-notes | **implemented** (shipped 2026-06-10, 54db674) |
| F5 | **`Tachyon: Init`** — stack detection (package.json/composer.json/Cargo.toml/…) → generated starter `tachyon.yml` | HiveTerm parity (stack detection), onboarding | S | — | pending |
| F6 | **CPU/mem monitor** — per-agent resource usage in the sidebar (pane PID → /proc) | HiveTerm parity | M | — | pending |
| F7 | **Publishing kit** — LICENSE file in package, marketplace icon PNG, categories/keywords, `vsce publish` dry-run | Product maturity | S | — | pending |
| F8 | **CI** — GitHub Actions: typecheck + build + vitest (+ xvfb integration) for `packages/tachyon/` | Product maturity | S | — | pending |
| F9 | **Multi-root workspaces** — today only the first folder is honored | Product maturity | M | — | pending |
| F10 | **Voice input** — speech → terminal input | HiveTerm parity | L | — | pending (recommendation: cancel — niche, paid deps; local `/transcribe` exists for other flows) |
| F11 | **Native Windows `PtyBackend`** | Platform reach | L | — | pending (recommendation: defer until real demand; WSL covers Windows) |
| F13 | **Agent CRUD from the UI** — New/Clone/Rename/Delete/Edit on the sidebar, mutating tachyon.yml via comment-preserving yaml Document API (file stays source of truth) | User request (pre-F9 foundation UX) | S/M | 193-tachyon-agent-crud-ui | **implemented** (shipped 2026-06-10, 25345e3) |
| F14 | **Sidebar taxonomy** — kind: agent\|terminal (inferred from cmd, explicit override) → grouped sidebar, kind-based attention defaults, kind in list_agents | User request (HiveTerm sidebar brief) | S/M | 194-tachyon-sidebar-taxonomy | **implemented** (shipped 2026-06-10, 1f0775a) |
| F16 | **Agent Studio** — webview form for create/edit (detected-CLI chips, flag chips, instructions role prompt with per-runtime startup delivery, browse, kind/policies) | User request (HiveTerm Add-agent modal brief) | M | 195-tachyon-agent-studio | **implemented** (shipped 2026-06-10, 409beac) |
| F17 | **Theming + i18n** — full --vscode-* token set + codicons in the Studio; vscode.l10n en/pt-BR following the editor display language; drift guards as tests | User questions on the Studio screen | S/M | 196-tachyon-theming-i18n | **implemented** (shipped 2026-06-10, c8742c7) |
| F18 | **Agent lineage** — spawn_agent parent (self-declared) + instructions; sidebar nests children under spawner; orphans promoted, never cascade-killed | User observation (HiveTerm demo video) | S/M | 197-tachyon-agent-lineage | **implemented** (shipped 2026-06-10, 2148b03) |
| F15 | **Commands (one-shot)** — third category: run→exit→show result (✓/✗+exit code), sidebar section + curated run_command Bridge tool; lifecycle inverted (exit expected) | HiveTerm parity ("Add command") | M | — | pending (**briefed** 2026-06-10 — design sketch in session; decide after F14/F9) |
| F12 | **Stable Bridge port + idempotent registration** — deterministic per-workspace port (override `settings.bridgePort`), no-op re-connect, merge-safe with pre-existing MCP files | User friction report (first live demo) | S | 189-tachyon-fixed-port-idempotent-registration | **implemented** (shipped 2026-06-09, f41480b) |

## Acceptance criteria

- [ ] Every backlog row (F1–F11) has a final decision: **implemented** (child spec shipped), **deferred** (with reopen trigger), or **cancelled** (with reasoning) — recorded in this table.
- [ ] Each implemented item went through its own child spec (`docs/specs/NNN-tachyon-*`), linked in the table.
- [ ] Decisions are made one item at a time with the user (no batch rubber-stamping).
- [ ] `packages/tachyon/` remains self-contained throughout; no `.agent0/`/`.claude/` changes from any child.

## Non-goals

- Implementing anything in this spec dir — children carry all code.
- Re-litigating v1 decisions (tmux backend, native terminals, WSL/Linux/macOS scope) — those are spec 186 closed decisions; F11 is the only sanctioned door back into platform scope.
- Feature-for-feature HiveTerm cloning as a goal in itself — each item must justify its own value for the multi-agent workflow, not "HiveTerm has it".

## Open questions

- [ ] Decision cadence: one child per session vs several — user-paced, no default enforced.

## Context / references

- Parent: `docs/specs/186-tachyon-vscode-extension/` (shipped 2026-06-09, `a388732`; sidebar increment `fa59007`).
- Gap analysis: this session 2026-06-09 (HiveTerm feature inventory vs delivered v1 + product-maturity review).
- HiveTerm feature reference: hiveterm.com (pins, monitoring, voice, stack detection, notify-when-needed).
- Attention-detection prior art: trsdn/HiveTerm (Swift homonym) "InputDetector — pattern matching plus process state analysis"; sentinel's tmux observation model.
