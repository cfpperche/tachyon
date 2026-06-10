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
| F1 | **Attention detection** — detect an agent waiting for human input (prompt/confirmation) and signal it (sidebar badge + notification) | HiveTerm parity; the core multi-agent value | M | 188-tachyon-attention-detection | in discussion |
| F2 | **Crash lifecycle** — exit-code visibility, death notification, `restart: on-crash` policy in `tachyon.yml` | HiveTerm parity (auto-restart/exit codes) | S/M | — | pending |
| F3 | **Bridge auth token** — per-session bearer token; close the "any local process can spawn agents" hole | Product hardening | S | — | pending |
| F4 | **Pins / notes** — pin output lines to a per-project checklist; agent-editable notes (+`create_pin`/`list_pins`/`set_notes` Bridge tools) | HiveTerm parity | M | — | pending |
| F5 | **`Tachyon: Init`** — stack detection (package.json/composer.json/Cargo.toml/…) → generated starter `tachyon.yml` | HiveTerm parity (stack detection), onboarding | S | — | pending |
| F6 | **CPU/mem monitor** — per-agent resource usage in the sidebar (pane PID → /proc) | HiveTerm parity | M | — | pending |
| F7 | **Publishing kit** — LICENSE file in package, marketplace icon PNG, categories/keywords, `vsce publish` dry-run | Product maturity | S | — | pending |
| F8 | **CI** — GitHub Actions: typecheck + build + vitest (+ xvfb integration) for `packages/tachyon/` | Product maturity | S | — | pending |
| F9 | **Multi-root workspaces** — today only the first folder is honored | Product maturity | M | — | pending |
| F10 | **Voice input** — speech → terminal input | HiveTerm parity | L | — | pending (recommendation: cancel — niche, paid deps; local `/transcribe` exists for other flows) |
| F11 | **Native Windows `PtyBackend`** | Platform reach | L | — | pending (recommendation: defer until real demand; WSL covers Windows) |

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
