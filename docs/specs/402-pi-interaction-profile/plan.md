# 402 — pi-interaction-profile — plan

_Drafted from `spec.md` on 2026-07-18._

## Approach

1. Extend `ComposerRegionProfile` with an optional framed-region shape: two matching border lines bound the editable region, and an optional footer/ready regex prevents launch-readiness false positives.
2. Generalize Attention's composer range helper. Existing prompt-glyph runtimes keep byte-equivalent behavior; framed runtimes compare both content outside the frame and inspect only lines inside it for occupancy.
3. Add the measured Pi composer profile: border `─{10,}`, footer token-usage/model line, bounded tail window, and any non-whitespace interior line as occupied.
4. Add a measured Pi graceful-stop profile using Escape, delayed Ctrl+C, delayed Ctrl+D, and a final conditional Ctrl+D retry. Delays let Pi finish active-turn abort/redraw before clear/exit.
5. Add fixtures and real-tmux dogfood for idle/draft/output changes/readiness and idle/draft/active-turn exit.
6. Update Pi/parity documentation, retaining `~` until human Dev Host approval.

## Key decisions

- **Framed region, not fake prompt regex** — Pi has no visible prompt glyph; matching arbitrary blank lines would classify footer/output as a composer.
- **Require footer for readiness** — trust dialogs also have horizontal borders, but not Pi's cwd/token/model footer.
- **Escape is unconditional for Pi Stop** — the existing `interruptActiveTurn` step is Codex-specific and would not detect Pi's spinner. Pi documents Escape as its native abort action and it is harmless in the idle editor.
- **Conditional delayed keys** — redraw/abort is asynchronous; spacing the clear/exit keys avoids racing Pi's state transition while still ending idle panes quickly.
- **Default keybindings only** — Tachyon does not mutate user Pi keymaps. A remapped app interrupt/clear/exit is an explicit compatibility caveat.

## Files touched

- `src/runtime/runtimeProfile.ts` — framed composer contract and Pi profile.
- `src/attention/AttentionMonitor.ts` — framed range occupancy/change detection.
- `src/runtime/launchReadiness.ts` — frame + footer readiness.
- `test/unit/{runtimeProfile,attention,launchReadinessRecovery}.test.ts` — pure/profile behavior.
- `scripts/dogfood/pi-interaction-profile.mjs` — isolated real tmux + Pi default-key behavior.
- `docs/runtimes/{pi,parity}.md` — measured status and limits.

## Risks & unknowns

- Pi's editor can grow to multiple lines; tail bounds must retain both borders and footer for normal drafts.
- A long draft taller than the bound cannot be safely classified and should degrade to unoccupied/ordinary output rather than guess.
- Theme/color changes are irrelevant to plain border matching, but Unicode width/alternate border customization could invalidate it.
- Sending Escape while idle can participate in Pi's configurable double-Escape action; one Escape followed by clear/exit was measured not to open a persistent selector.

## Visual impact

No new components. The sidebar's existing Attention state and composer protection become accurate for Pi. Human Dev Host dogfood confirms idle/draft state and clean Stop behavior.

## Sources consulted

- Pi `docs/keybindings.md`, `docs/tui.md`, and v0.80.10 live tmux captures (plain + escaped).
- `src/runtime/runtimeProfile.ts`, `src/attention/AttentionMonitor.ts`, `src/runtime/launchReadiness.ts`, and composer regression suites.
- SDD 358 runtime profiles and existing Codex/Grok stop measurements.
