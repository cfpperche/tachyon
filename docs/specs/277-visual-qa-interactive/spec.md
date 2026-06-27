# 277 — visual-qa-interactive

_Created 2026-06-27._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** shipped 2026-06-27. The `visual-qa` skill is now INVOCATION-driven (`/visual-qa <surface-or-url>
--anchor "<intent>"`), with the spec-275 config kept as a PERSISTENT BASELINE/fallback. SKILL.md rewritten as an
executable Resolution Algorithm (precedence table → provenance table → runtime-readiness branches → mixed-provenance
rule → capture/judge/attach-with-provenance), `argument-hint` frontmatter added. Config `schema.json` v2: `anchor`/
`routes` now OPTIONAL (the invocation supplies them); the anchor-required rule moved from a schema requirement to a
runtime check; `additionalProperties:false` + `$schema` allowance retained. Codex dueto folded (mixed-provenance
footgun: no silent anchor-borrow for an ad-hoc target; `setup` only for harness/config targets; provenance recorded
in the evidence `data`; ask-for-URL as the first-class fallback). Verified: ajv (empty config valid, baseline valid,
extra-key rejected, anchor-when-present still constrained); engine `loadPlugin` accepts the v2 plugin (skill
discovered, manifest/deps/config-schema valid); description 988/1024c. Plugin-only — no Tachyon core change.
DEFERRED: named-surface→route DISCOVERY + the all-Tachyon-views preview harness (a separate project-side spec, the
"passo 0" the owner flagged).

> **Origin (owner):** spec 275's visual-qa is CONFIG-file-driven — fine for PERSISTENT/CI use ("QA these surfaces
> against this intent every PR") but terrible INTERACTIVE: editing a JSON config to QA a different surface
> mid-session is absurd. In a live session you should just say *"/visual-qa the Agent Studio tabs — they should be
> consistent codicons"* and have it run, no file edit. This spec makes the skill INVOCATION-driven, with the spec-275
> config kept as a PERSISTENT BASELINE/fallback (owner's call).
>
> **Codex dueto (2026-06-27) — SHIP-WITH-CHANGES, folded:** the real risk isn't "invocation overrides config", it's
> **mixed provenance** — an inline ad-hoc target silently inheriting a config anchor written for a DIFFERENT surface.
> Folded: provenance-sensitive rules (no silent anchor-borrow; `setup` only for harness/config targets; inline target
> overrides the whole route set); a runtime-readiness check kept DISTINCT from schema validation (schema-valid ≠
> run-ready); the SKILL.md must be an executable Resolution Algorithm (ordered steps + provenance table + exact
> refusal strings), not narrative; provenance recorded in the evidence `data`; named-surface fallback = ask-for-URL
> as the FIRST-CLASS path (never "go edit config"). All 4 OQs resolved.

## Intent

Make the `visual-qa` skill accept the **target** + the **design-intent anchor** at INVOCATION (inline, from the
conversation/args), so a human (or an orchestrating agent) runs ad-hoc Visual QA without editing the config. The
spec-275 `config` becomes a persistent BASELINE used when the invocation omits something — NOT the only input.

**The discipline is unchanged — only the channel improves.** "The human declares the anchor" still holds; the human
now declares it by TYPING it (the command) instead of editing a file. No anchor from EITHER channel → still
`unable_to_judge`. No silent inference.

## Resolution precedence (the heart of v2)

For each input, **invocation wins, then config baseline, then a clear fallback:**

| input | from invocation | else config baseline | else |
|---|---|---|---|
| **anchor** | inline intent text, or a doc path/url given in the ask | `config.anchor` | `unable_to_judge` (never guess) |
| **target** | a direct URL, OR a named surface | `config.routes` | ask the human for a URL |
| **viewports** | optional override | `config.viewports` | default desktop 1440×900 |
| **setup** | — | `config.setup` (serve the harness etc.) | none (assume reachable) |

- A **direct URL** target is used as-is.
- A **named surface** ("the Agent Studio tabs") requires DISCOVERY to map name→route — DEFERRED to the harness
  route-catalog (a separate project spec). Until it exists: if the name isn't a known `config.routes` entry, the
  skill ASKS the human for the URL — that ask is the FIRST-CLASS path, NOT "go add it to config" (sending the human
  back to a file edit recreates the exact pain this spec removes). It never fabricates a URL.

### Mixed-provenance footgun (folded from Codex — the one real risk)

The hazard is NOT "invocation wins" — it's an **inline ad-hoc target inheriting a config anchor written for a
DIFFERENT surface** (judging Surface B against Surface A's intent, silently). Rules:

- **Inline target ⇒ inline anchor strongly preferred.** When the target comes from the invocation (a direct URL or an
  ad-hoc named surface) but NO anchor is supplied inline, the skill does NOT silently borrow `config.anchor`. It
  either (a) asks the human for the intent, or (b) proceeds against `config.anchor` ONLY with an explicit run note +
  the `mixed_provenance` flag recorded in evidence, so a later reviewer sees the anchor wasn't written for this
  target. Never a silent borrow.
- **Inline target overrides the ENTIRE config route set** for that run (OQ3 = override): ad-hoc means "judge THIS
  now", not "append to the baseline suite".
- **`setup` runs only for config-route / harness targets, never blindly for an arbitrary external URL** — a baseline
  `npm run preview:webview` is meaningless (and wrong) for `https://example.com`.
- viewports/setup mixing is safe (no semantic coupling) and falls back to config freely.

## The skill v2 contract

- **`argument-hint`** added, e.g. `[<surface-or-url>] [--anchor "<intent>" | --anchor-path <doc>]`. The skill also
  reads the surrounding conversation for the target + anchor (natural-language invocation) — structured form
  preferred, NL extraction as fallback (OQ1 = both).
- **A crisp "Resolution Algorithm" section, not narrative (folded from Codex).** Prose that only says "invocation
  wins" drifts on edge cases. The SKILL.md carries ordered steps the agent executes: resolve each input by the
  precedence table → fill a provenance table (`anchor_value/source`, `target_value/source`, `viewports_source`,
  `setup_source`) → apply the runtime-readiness branches → apply the mixed-provenance rule → capture → judge →
  attach with provenance in `data`. It reads like executable policy, with the **exact refusal/ask strings** for
  missing-anchor (`unable_to_judge`) and unresolved-named-surface (ask-for-URL) inlined.
- **Reads invocation first, config as fallback** (per the precedence table). Runs `config.setup` ONLY for a config-route
  / harness target — never for an arbitrary inline URL.
- Everything else from spec 275 is unchanged: drives `agent-browser`, screenshots to `.vqa/visual-qa/*`, judges vs
  the anchor (written intent, not a pixel oracle), attaches a `judgment` verdict via `attach_evidence`. Advisory,
  never gates. Web-only.

## Config schema v2 (baseline, not required)

`config/schema.json`: `anchor` and `routes` become **OPTIONAL** (a config can now be empty/minimal because the
invocation supplies them). `setup`/`viewports` stay optional. Keep `additionalProperties:false` (+ the `$schema`
allowance from v0.12.2).

**Schema-valid ≠ run-ready (folded from Codex).** Making `anchor`/`routes` optional means schema validation now only
asserts "the config FILE is structurally valid" — it no longer guarantees "a no-args run is runnable". Those are two
different checks and the spec keeps them separate:

| check | asserts | failure |
|---|---|---|
| **schema validation** | config file is well-formed | editor warning (the ⚠ badge) |
| **runtime readiness** (skill, per run) | this run has an anchor AND a target, from EITHER channel | ask / `unable_to_judge` |

Runtime-readiness branches:
- no target from invocation AND no `config.routes` → **ask the human for a URL** (first-class).
- no anchor from invocation AND no `config.anchor` → **`unable_to_judge`** (with the reason — never a taste-guess).

An empty config is therefore VALID but only useful for invocation-driven runs — documented in the SKILL.md.

### Provenance recorded in evidence (OQ4 = yes, folded)

Every run records WHERE each input came from, so a mixed invocation/config run is debuggable and a reviewer never
mistakes a borrowed anchor for inferred intent. The `attach_evidence` `data` carries:

```json
{ "anchor_source": "invocation|config|human_followup|missing",
  "target_source": "invocation|config|human_followup",
  "viewports_source": "invocation|config|default",
  "setup_source": "config|none",
  "mixed_provenance": true }
```

## Acceptance criteria

- [x] **Ad-hoc run, no config edit:** invoking `/visual-qa <url> --anchor "<intent>"` runs the full flow
  (capture→judge→attach) using ONLY the inline target + anchor, even when `config.anchor`/`config.routes` are absent.
- [x] **Config baseline still works:** with no invocation args, the skill runs against `config.routes`/`config.anchor`
  exactly as spec 275 (persistent/CI path unchanged).
- [x] **Precedence:** an inline anchor/target OVERRIDES the config baseline for that run; viewports/setup fall back to
  config.
- [x] **Anchor still required (runtime, both channels):** no anchor from invocation AND none in config →
  `unable_to_judge`, with the reason — never a taste-guess.
- [x] **Named-surface honesty:** a named target with no matching `config.routes` entry (and no route catalog yet) →
  the skill asks the human for the URL; it does NOT invent one. Discovery is deferred.
- [x] **Schema v2:** `anchor`/`routes` optional; a minimal/empty config validates; `additionalProperties:false` +
  `$schema` allowance retained.
- [x] **Schema-valid ≠ run-ready:** an empty config validates structurally; a no-args run against it hits the
  runtime-readiness branches (ask-for-URL / `unable_to_judge`), NOT a schema error.
- [x] **Mixed-provenance guarded:** an inline URL with no inline anchor does NOT silently borrow `config.anchor` — it
  asks, or proceeds with an explicit run note + `mixed_provenance` in evidence. `setup` never runs for an arbitrary
  inline URL.
- [x] **Provenance recorded:** the attached verdict's `data` records `anchor_source`/`target_source`/
  `viewports_source`/`setup_source` (+ `mixed_provenance`).
- [x] **SKILL.md is executable policy:** it contains the ordered Resolution Algorithm + provenance table + the exact
  refusal/ask strings (not just narrative "invocation wins").

## Open questions — RESOLVED (Codex dueto 2026-06-27, leans confirmed)

- **OQ1 (invocation syntax)** — **both.** Structured `argument-hint` is the preferred path; natural-language
  extraction from the conversation is the fallback.
- **OQ2 (anchor channels)** — **all three** (inline text, `--anchor-path <doc>`, URL), mirroring the config anchor
  shape; the run records WHICH was used.
- **OQ3 (override vs add)** — **override.** An inline target means "judge THIS now", replacing the config route set
  for that run, not appending to it.
- **OQ4 (record provenance)** — **yes.** Provenance is recorded in the evidence `data` (the JSON block above) — it's
  what makes a mixed invocation/config run debuggable and stops a reviewer mistaking a borrowed anchor for inference.

## Non-goals

- The route-catalog DISCOVERY (named-surface→route) and the all-Tachyon-views preview harness — a SEPARATE
  project-side spec (this v2 only consumes a URL or a config-route name).
- Any Tachyon CORE change (this is a plugin SKILL.md + config-schema evolution).
- Native/desktop Visual QA (still the future `agent-screen`); a pixel-diff regression gate.
