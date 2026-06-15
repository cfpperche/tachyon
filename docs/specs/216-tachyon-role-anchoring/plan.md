# 216 — tachyon-role-anchoring — plan

## Approach
Three parts, smallest-blast-radius first. A and B are config/prose (safe, no engine change in the
hot path); C touches the AttentionMonitor + a new injection path (the risky bit, opt-in/off).

## Part A — role templates (`src/config/` + `src/roles/` + Studio)
- `src/roles/templates.ts` (NEW, pure): `ROLES = ["coder","reviewer","tester","orchestrator","custom"]`;
  `roleTemplate(role): string` returning a behavior-contract (English, no persona language);
  `composeInstructions(role, instructions): string|undefined` = template then instructions.
- `loadConfig.ts`: add optional `role` to `AgentDef` + `AGENT_KEYS`; validate against `ROLES`;
  rejected under `terminals:` (no AI). `composeCommand` already takes `{cmd,instructions}` — feed it
  `composeInstructions(def.role, def.instructions)` at the spawn call sites (AgentManager).
- schema: `role` enum on the agent shape.
- Studio (`AgentForm.ts`/`formLogic.ts`): role dropdown on the Agent tab; preview the template;
  `instructions` box stays the addendum. `YamlConfigEditor.upsertAgent` round-trips `role`.

## Part B — Bridge-coordination guidance (`src/roles/` + spawn path)
- `bridgeGuidanceTail()` (pure, in roles or a sibling): the short coordination note.
- Appended to a child's composed instructions **only when spawned via the Bridge** (carry a
  `viaBridge`/`parent` signal through `AgentManager.spawn` opts to the compose step). Suppressed by
  `settings.bridgeGuidance === false`.

## Part C — re-anchoring (`src/anchor/` + AttentionMonitor + Bridge/command)
- `src/anchor/compaction.ts` (NEW, pure): `detectCompaction(cmd, paneTail): boolean` — per-runtime
  marker regexes (claude + codex), runtime resolved from the cmd (reuse existing adapter detection).
- `AttentionMonitor`: on each tick, after classifying, run the detector on the captured content; when
  it fires, mark `compactedSinceAnchor` for that agent (new per-snapshot flag) and surface via a new
  `onChange`-adjacent callback or a `compactedAgents()` getter. Keep the monitor pure/testable.
- `Workspace`: own the anchor policy — when an agent is flagged AND transitions to `idle` AND
  `settings.anchor.auto`, call `reanchor(agent)` once per episode (clear the flag); `reanchor` builds
  the compact role reminder and `tmux.sendKeys(session, reminder, true)`.
- Manual path: `reanchor_agent` Bridge tool + a palette command "Tachyon: Re-anchor agent" → same
  `reanchor()`. Always available regardless of the auto flag.
- Durable fallback: write `.tachyon/ROLE.md` (per-agent section or one doc) on spawn, mirroring the
  composed role; the reminder text points the agent at it.
- settings: `settings.anchor.auto` (bool, default false), `settings.bridgeGuidance` (bool, default
  true) in loadConfig + schema.

## Tests (TDD, vitest)
- roles: template content (no persona regex), compose order, unknown-role parse error, terminals
  rejection, byte-identical launch when no role.
- guidance: appended only via-bridge, suppressed by setting.
- compaction: claude + codex fixture panes → detect; clean panes + other runtimes → no detect.
- anchor policy: fires only idle-after-compaction, once/episode, never working/needs-input, gated by
  flag; manual path works with flag off. (Pure policy unit + one real-tmux smoke for sendKeys.)

## Risks
- Injection races the human → mitigated by idle-only + once/episode + default off (D-A).
- Compaction markers drift per CLI version → isolate in `compaction.ts`, fixture-tested, documented
  as best-effort; manual path is the guarantee.
- Persona-creep in templates → reviewer checks for identity language; contracts are task-scoped.

## codex dueto
Two-runtime review after green (like 210/214): NO-SHIP findings fixed, re-review until SHIP. Part C
gets the heaviest scrutiny (injection timing, episode keying, runtime gaps).
