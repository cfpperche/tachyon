# 196 — tachyon-theming-i18n

_Created 2026-06-10._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F17** (user questions on the Studio screen, 2026-06-10: theme design-system? i18n? language choice?). Three answers turned into scope: (1) **full theme integration** — the Studio form upgrades from ~10 to the full relevant --vscode-* token set (hover/placeholder/validation/focus/widget borders, checkbox accent) plus the official **codicon font** bundled at build time (chips and kind toggles use the same icons as the sidebar; light/high-contrast inherit automatically); (2) **i18n via the official vscode.l10n mechanism** — every human-facing string (94 keys: toasts, sidebar states/tooltips, quickpicks, modals, the whole Studio form via init payload) wrapped in l10n.t with a **pt-BR bundle**, plus package.nls.json/.pt-br.json for static contributions (23 command titles, settings, view names); (3) **language follows the editor's display language** (the idiomatic behavior — no custom picker, by design). Architecture kept honest: formLogic validation now returns **stable issue codes** mapped to localized messages at the UI boundary (logic stays vscode-free and testable); webview strings are resolved extension-side and shipped in the init message. Deliberate exception recorded: Bridge tool descriptions stay English — their audience is models reading the MCP schema. Drift guards as tests: bundle completeness vs source keys, placeholder fidelity, and %key% resolution.

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: language follows the editor**
  - **Given** VS Code display language set to pt-BR
  - **When** Tachyon shows any toast, sidebar state, modal or the Studio form
  - **Then** the text renders in pt-BR (en otherwise); no extension-level language setting exists

- [x] **Scenario: static contributions localized**
  - **Given** the command palette and settings UI
  - **Then** command titles/config/view names come from package.nls (pt-BR variant under pt-BR), with no raw %key% leaking (asserted live)

- [x] **Scenario: themed form**
  - **Given** any color theme (dark/light/high-contrast)
  - **When** the Agent Studio renders
  - **Then** controls use the theme's tokens (inputs, buttons incl. hover, validation error box, focus rings) and codicons render from the bundled font

- [x] Validation messages: formLogic returns stable issue codes; localization happens at the UI boundary (logic vscode-free)
- [x] Drift guards in the suite: every l10n.t source key exists in the pt-BR bundle; translations preserve {n} placeholders; every %key% exists in both nls files
- [x] Bridge tool descriptions remain English (decision recorded)
- [x] vsix ships l10n/ + package.nls*.json + dist/webview/codicon.{css,ttf}

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- A Tachyon-specific language picker setting — anti-pattern; the editor's display language is the source of truth.
- Localizing Bridge tool descriptions (audience = models) or error messages thrown by vscode-free layers (manager/tmux — may surface in toasts in English; documented residual).
- Additional locales beyond en/pt-BR — the bundle structure makes them one-file additions.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — the three user questions were the requirements._

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F17).
- Mechanisms: vscode.l10n + package.nls (code.visualstudio.com/api/references/vscode-api#l10n); @vscode/codicons (MIT).
