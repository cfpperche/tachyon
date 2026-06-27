# 275 — visual-qa-skill

_Created 2026-06-27._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Amendment (2026-06-27, owner-driven):** the plugin `config` gained an OPTIONAL `setup` field
(`{command?, readyUrl?, notes?}`) — the project's own "how to make my UI reachable" (human/agent-authored, same
trust as a project CLAUDE.md; not a security input), which the SKILL.md runs at preflight. This ABSORBS spec 274's
recipe doc (now deleted): the plugin is the single home for Visual QA — generic flow in the SKILL.md, project
specifics (anchor/routes/setup) in config; the only irreducible project code is the preview harness. It also lets
Tachyon dogfood the plugin against its OWN webview UI (set `setup.command` to serve the harness, `routes` to the
harness URLs) — no external consumer app needed.

**Closure:** shipped 2026-06-27 — the `visual-qa` plugin built + pushed to `tachyon-plugins` (`ca42174`) + the spec
on `tachyon` main (`1db0316`). The deliverable (a description-selectable Visual QA SKILL that delegates capture to
the agent-browser plugin, judges vs a declared anchor, and attaches via spec-273 `attach_evidence`) is built and
ENGINE-VALIDATED (loadPlugin 0 errors, preview 0 warnings, materializes into claude+codex). Honest correction during
build: Tachyon has NO plugin-dependency manifest mechanism (verified) → agent-browser is a runtime PREFLIGHT +
degrade, not a manifest dep. **In-use / deferred (not headless-provable here):** a LIVE dogfood (an agent running
visual-qa against a real consumer web app, in a running VS Code Tachyon) is the in-use proof; a `tachyon-plugins`
release tag; an optional final built-plugin dueto. Native/desktop Visual QA → the future `agent-screen` spec.

> **Origin:** spec 274 shipped the Visual QA recipe for Tachyon's OWN webview UI (a doc + a dev harness). A
> recipe-as-doc has NO discovery. This spec GRADUATES it into a distributable **SKILL** (a Tachyon plugin) so a
> consumer project's agent selects it by DESCRIPTION-matching for UI-review tasks. Scope: consumer **web** UIs (a
> real URL — no harness). Native/desktop → the future `agent-screen` primitive.
>
> **Codex design dueto (2026-06-27) — SHIP-WITH-CHANGES, folded** (`…20260627T192119Z-…`): trigger phrases +
> non-triggers (description isn't a deterministic trigger); anchor quality bar (≥1 of text/path/url, verdict cites
> the dimensions judged, baselines never canonical); a mandated screenshot path convention; auth/write-gate handled
> by preferring direct URLs + pre-auth (mutating nav → `unable_to_judge`); CUT all project inference from v1
> (URL/routes declared, never guessed); explicit viewports + a stabilization wait. **Corrected (verified vs code):**
> Tachyon has NO plugin-to-plugin manifest `dependencies` mechanism — so the `agent-browser` reliance is a RUNTIME
> PREFLIGHT + degrade, not a manifest dependency.

## Intent

Ship a `visual-qa` plugin whose SKILL lets a Tachyon-orchestrated agent in a consumer project produce an advisory
Visual QA verdict on a web UI change and attach it to the worktree evidence channel — discoverable because the
skill's description matches a UI-fidelity-review task. Reuses:

- **`agent-browser` plugin** (v2.x, same repo) — the pinned Chrome-driving CLI + navigate/screenshot skill. Visual
  QA DELEGATES browser-driving to it. **No manifest dependency exists** → the skill PREFLIGHTS at runtime (is the
  launcher/CLI present?) and returns `unable_to_judge` + an "install the agent-browser plugin" hint when absent.
- **The evidence channel** (`attach_evidence`, spec 273 core) — durable screenshots + the verdict land here.

## What the consumer DECLARES (never guessed — v1 cuts inference)

Via the plugin **config** (spec 270) or at invocation:
- **the design-intent ANCHOR — REQUIRED, ≥1 of:** `anchor.text` (inline intent), `anchor.path` (a repo design doc),
  `anchor.url` (a design-system link). No anchor → `unable_to_judge` (never a taste-guess). The verdict MUST cite
  the anchor dimensions it judged. Prior screenshots are CONTEXT, never canonical baselines.
- **the URL + the routes to check — REQUIRED (declared, not inferred in v1):** a bounded route list, not "the UI".
- **viewports — optional:** default desktop `1440x900`; add mobile `390x844` only when configured/requested.

## The flow (the skill)

1. **preflight:** anchor present? agent-browser available? URL/routes declared? → any "no" yields `unable_to_judge`
   with a concrete reason, not a guess.
2. **capture:** drive `agent-browser` to navigate each route at each viewport and screenshot, saving to a
   worktree-relative `.vqa/visual-qa/<route>-<viewport>.png`. Prefer DIRECT URLs + pre-authenticated saved state;
   if reaching a route needs a state-mutating action (held by agent-browser's write-gate) → `unable_to_judge` or
   ask the human, don't build an elaborate auto-click flow. Wait for network-idle / a selector before shooting
   (note volatile regions as limitations).
3. **judge:** against the anchor (written intent, NOT a pixel oracle); cite concrete observations per dimension;
   verdict ∈ `pass|concern|fail|unable_to_judge`. Advisory model judgment — context, not truth.
4. **attach:** `attach_evidence` (kind `judgment`, severity `info|warn|error`, summary + observations + the `.vqa/*`
   screenshot refs → Tachyon copies them to managed storage). Never gates.

## Acceptance criteria

- [x] **Installable + description-selectable (not deterministic):** plugin `tachyon-plugins/visual-qa`; the SKILL.md
  description carries trigger phrases ("visual QA", "does this UI/page look right", "review … for visual fidelity")
  AND explicit non-triggers (functional/e2e, accessibility audit). Engine-validated installable.
- [x] **agent-browser preflight + degrade:** the SKILL.md delegates capture to the agent-browser plugin and
  preflights it → `unable_to_judge` + install hint when absent (runtime check; NO manifest dependency — corrected).
- [x] **Anchor required + cited:** `config/schema.json` requires `anchor` (`minProperties:1` of text/path/url); the
  SKILL.md mandates citing the dimensions judged + forbids baseline-as-truth.
- [x] **Declared inputs (no v1 inference):** the schema requires `routes`; the SKILL.md states v1 does NOT infer
  URL/routes.
- [x] **Durable evidence, advisory:** the SKILL.md writes `.vqa/visual-qa/*` and attaches via `attach_evidence`
  (the durable-copy mechanism is built+tested in 273/274); advisory, never gates. *(Live agent-run = in-use proof.)*
- [x] **Web-only honesty:** the SKILL.md + README state browser-routable UIs only; native/desktop deferred.

## Open questions — RESOLVED (codex leans folded)

- **OQ1 (anchor):** config supports `anchor.text` / `anchor.path` / `anchor.url`; require ≥1.
- **OQ2 (agent-browser reliance):** runtime preflight + degrade to `unable_to_judge` (no manifest dep exists);
  document "install agent-browser alongside".
- **OQ3 (URL/routes):** declared in config or at invocation only; NO project inference in v1.
- **OQ4 (screenshots):** worktree-relative `.vqa/visual-qa/*.png`; pass those refs to `attach_evidence`.
- **OQ5 (config home):** ship plugin `config` for anchor/routes/viewport defaults; project-convention files later.

## Non-goals

- Native/desktop/mobile/TUI Visual QA (needs `agent-screen` — later spec).
- A pixel-diff regression gate / baseline-management UX (the retired frozen visual contract).
- Re-implementing browser-driving (delegated to `agent-browser`); a plugin-dependency mechanism (doesn't exist);
  CI gating; project-convention inference.
