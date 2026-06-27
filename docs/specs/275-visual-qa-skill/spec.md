# 275 — visual-qa-skill

_Created 2026-06-27._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

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

- [ ] **Installable + description-selectable (not deterministic):** a plugin in `tachyon-plugins`; the SKILL.md
  description carries trigger phrases ("visual QA", "does this UI/page look right", "review the UI for visual
  fidelity") AND explicit non-triggers (functional/e2e correctness, accessibility audit), plus a documented manual
  invocation. "Discoverable" is description-matching, NOT a guaranteed trigger.
- [ ] **agent-browser preflight + degrade:** uses the agent-browser plugin to navigate + screenshot a consumer web
  app at its real URL; absent launcher/CLI → `unable_to_judge` + install hint (NO manifest dependency — runtime
  check).
- [ ] **Anchor required + cited:** no anchor → `unable_to_judge`; with an anchor (text/path/url) the verdict
  references the dimensions judged; prior screenshots are never treated as canonical baselines.
- [ ] **Declared inputs (no v1 inference):** URL + a bounded route list come from config/invocation; the skill does
  NOT guess them from project scripts/README/the diff in v1.
- [ ] **Durable evidence, advisory:** the verdict attaches via `attach_evidence` with screenshots written to
  `.vqa/visual-qa/*` (copied to managed storage), readable via `list_evidence`/`verify_agent`; never gates.
- [ ] **Web-only honesty:** the skill states it covers browser-routable UIs; native/desktop is out of scope.

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
