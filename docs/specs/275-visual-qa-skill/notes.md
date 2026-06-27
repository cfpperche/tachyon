# 275 — notes

## Origin
Graduates the spec-274 Visual QA recipe (Tachyon-own, a doc) into a distributable SKILL (a plugin) for CONSUMER web
apps, discoverable by description-matching. Answers the owner's "how does a consumer discover the recipe?" — it
doesn't guess; it installs a skill whose description an agent matches to a UI-review task.

## Codex design dueto — SHIP-WITH-CHANGES (`…20260627T192119Z`), folded
1. **Manifest plugin-dependency — CORRECTED:** codex claimed Tachyon supports `dependencies: ["name@range"]`;
   VERIFIED against `src/plugins/manifest.ts` — it does NOT (only `requiresEnv` for MCP). So the agent-browser
   reliance is a RUNTIME PREFLIGHT + degrade to `unable_to_judge`, not a manifest dependency.
2. Description-selectable is NOT deterministic → add trigger phrases + explicit non-triggers + a manual invocation
   path; don't claim a guaranteed trigger.
3. Anchor quality bar: ≥1 of text/path/url; the verdict must cite the dimensions judged; prior screenshots never
   canonical baselines (avoids the retired frozen visual contract).
4. Mandate a worktree-relative screenshot convention `.vqa/visual-qa/*.png` (aligns with attach_evidence's copy).
5. Auth/write-gate: prefer direct URLs + pre-auth saved state; mutating navigation → `unable_to_judge`/ask, no
   elaborate auto-click flow.
6. CUT inference from v1: URL + a bounded route list are DECLARED (config/invocation), never guessed.
Missed: explicit viewports (desktop 1440x900 default; mobile 390x844 when configured); a stabilization wait;
bounded routes; judge = advisory not truth; no CI gating in v1.

## Build plan (plugin in tachyon-plugins/visual-qa)
- `tachyon-plugin.json` — name `visual-qa`, runtimes claude+codex, `config` (anchor/routes/viewports), NO tools
  (delegates browser-driving to the agent-browser plugin).
- `config/schema.json` + a default `config/visual-qa.json`.
- `skills/visual-qa/SKILL.md` — the description-selectable skill + the 4-step flow + preflight/degrade.
- README.md.
Reuses: the agent-browser plugin (preflight) + `attach_evidence` (spec 273). No harness (consumer web app has a URL).
OQ1-5 resolved in spec.md.

## Build progress
- **Plugin BUILT** in `tachyon-plugins/visual-qa/` (manifest + config schema + default config + SKILL.md + README).
  Engine-validated: loadPlugin 0 errors, preview 0 errors + 0 warnings (no `${tool:}`), tools=[] (delegates to
  agent-browser), materializes into `.claude/skills` + `.agents/skills`. Description carries trigger phrases +
  explicit non-triggers; config requires `anchor` (≥1 of text/path/url) + bounded `routes`.
- **Dogfood DONE (headless, 2026-06-27) — Tachyon dogfoods the plugin against its OWN UI via the harness.** Install:
  `applyInstall` → installed, the SKILL materializes into BOTH `.claude/skills` + `.agents/skills`, and the spec-270
  config materializes at `.tachyon/plugins/visual-qa/config/visual-qa.json` carrying the `setup` field. Producer
  flow (real code path): `setup` served the harness → Chrome screenshotted the evidence-badge route into the
  worktree `.vqa/visual-qa/*.png` → judged (`pass`, concrete observations on the ⊙ badge) → `copyEvidenceArtifacts`
  copied it to managed storage + `appendEvidence` recorded the judgment → readback shows the verdict + summary →
  **removed the worktree, the managed screenshot survived (durability proven)**. Verified for both runtimes.
- **Still pending (in-VS-Code / gated):** the LIVE MCP-bridge `attach_evidence` + an agent SELECTING the skill in a
  running VS Code (the owner confirms in-window); a `tachyon-plugins` tag; an optional final built-plugin dueto.
