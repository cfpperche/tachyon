# 486 — plugin-apply-vs-install — notes

_Created 2026-08-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Measurements — A1 and A1b

_Measured 2026-08-06 by `plugapply` for `t-5d219f`. A1 and A1b came before A3–A5 on purpose. The
answers below restrict what A5 is allowed to promise._

### Method

- Host: Linux 6.6 (WSL2). Date: 2026-08-06.
- Runtime versions: `claude 2.1.223`, `codex-cli 0.146.1`, `grok 0.2.118`.
- Each measurement used ONE live session. The test changed files while that session stayed alive.
- Claude ran headless and multi-turn: `claude -p --input-format stream-json --output-format stream-json`.
- Codex and Grok ran as their interactive TUI in a `tmux` pane.
- The evidence is a tool result or a hook side-effect file. Model narration is never the proof.
- Sandbox workspaces were outside this repository. Each hook sandbox was a git repository.
- A skill probe is a `probe-token` skill directory. A hook probe is a `UserPromptSubmit` hook.
- The hook writes one line to a log file. A slow hook writes a start line, sleeps 25 seconds, then
  writes an end line.

### A1 — a skill directory disappears mid-session

| Runtime | Process survives | Next invocation | Skill still offered |
|---|---|---|---|
| claude 2.1.223 | yes, exits 0 later | recoverable tool error | no |
| codex 0.146.1 | yes | no skill tool exists; the listed file is gone | no |
| grok 0.2.118 | yes | recoverable tool error | no |

**No runtime crashes. No runtime wedges.** Every session answered a later prompt correctly. This is
the answer A5 needed: the switch may remove a skill while an agent runs.

Per runtime:

- **claude.** The `Skill` tool returned `<tool_use_error>Unknown skill: probe-token</tool_use_error>`.
  Four of four runs returned that error, measured 2 seconds after the removal. The session then
  answered a later prompt. The process exited with code 0.
- **claude, the race.** With no delay between the removal and the next prompt, one of three runs still
  invoked the removed skill successfully. So an un-apply is true within about two seconds, not
  instantly. A5 must not claim that un-apply takes effect at the moment of the click.
- **claude, the other direction.** A skill directory added mid-session became invocable in the same
  session. No restart was needed.
- **codex.** Codex offers no skill-invocation tool in this build. It lists each `SKILL.md` inside its
  instructions with a `file:` locator. `codex debug prompt-input` shows that list. After the removal,
  the model listed its skills and did not name `probe-token`. That run never named the skill before
  the removal, so conversation history cannot explain the answer.
- **grok.** The skill read tool returned `Error: <path>/SKILL.md does not exist.` The session then
  answered a later prompt. A cold listing after the removal also did not name `probe-token`.

Not measured for A1:

- Whether claude refreshes its per-turn skill listing. The pre-removal listing stays in conversation
  history either way, so that question needs a different probe. The tool result is decisive on its
  own, so this gap does not change the A1 answer.
- Removal DURING an active skill execution.
- Several agents holding the same skill at once.

### A1b — a hook entry disappears mid-session

Part (i) — does the removal take effect, or does it need a restart?

| Runtime | Fires again after removal | Entry added mid-session arms | Verdict |
|---|---|---|---|
| claude 2.1.223 | no | yes | live re-read |
| codex 0.146.1 | **yes** | no | set fixed at session start |
| grok 0.2.118 | **yes** | no | set fixed at session start |

Part (ii) — is a hook that is MID-EXECUTION killed when its entry disappears?

| Runtime | Running hook killed | Evidence |
|---|---|---|
| claude 2.1.223 | no | the end line was written |
| codex 0.146.1 | no | the end line was written |
| grok 0.2.118 | no | the end line was written |

**This is the finding that constrains A5.** On codex and on grok, an un-apply switch that reads
"disarmed" would be wrong. Both runtimes keep running the hook they loaded at session start.

The proof is stronger than "it fired again". On both runtimes the test then REPLACED the hook file
with a different command. The next prompt still ran the ORIGINAL command. So neither runtime re-reads
the file at all during a session. Grok's own installed guide agrees: it documents a manual reload,
`r` in the Hooks tab, and calls it "Mid-Session Reload".

Claude behaves the other way. The removal stopped the hook on the very next prompt. A different hook
added mid-session fired on the prompt after that.

### A1b — two gates Tachyon does not own

Both findings are new constraints on the word "applied".

- **Codex gates a project hook behind a REVIEW decision.** A newly installed hook shows as
  `Installed 1, Active 0, Review 1` and never fires. The screen says "1 hook needs review before it
  can run". A human presses `t` to trust it. Codex persists that decision in `~/.codex/config.toml`
  under `[hooks.state."<file>:<event>:<i>:<j>"]`, with a `trusted_hash` and an `enabled` flag. The
  hash is over the hook content, so editing an applied hook re-opens the gate.
- **Codex needed a session restart before the trusted hook fired.** Trust granted inside a session did
  not arm the already-loaded set. Honest caveat: two variables changed between those two runs — the
  restart, and a hook command rewritten from an inline `sh -c` string to an absolute script path. The
  restart is the likely cause, because part (i) independently proves the hook set is fixed at session
  start. Nothing here isolated the two.
- **Grok gates project hooks behind FOLDER TRUST.** `grok inspect` reported `Hooks (0)` and
  `Project trusted: no`. Running `/hooks-trust` changed both. Grok records the grant in
  `~/.grok/trusted_folders.toml`.

Consequence for A5: on codex and on grok, "Tachyon applied it" does not mean "the code will run".
A card that shows only Tachyon's own switch would claim an arming Tachyon cannot deliver.

### A1b — a discovery precondition worth writing down

Grok did NOT discover `<project>/.grok/hooks/*.json` while the directory was not a git repository.
The identical file at `~/.grok/hooks/` was discovered in the same check. After `git init`, the
project file was discovered as scope `project`.

This does not refute `engine.ts`'s `settingsRel` for grok. A Tachyon workspace is a git repository, so
the product path is unaffected. It is recorded because it cost an hour and produced a false negative
first: an undiscovered hook never fires, and "it did not fire" looks exactly like "the removal
worked".

### Measurement residue on the host

- **Codex was upgraded by accident, from 0.146.0 to 0.146.1.** A blind Enter from the driver script
  landed on the codex update selector, which ran `npm install -g @openai/codex`. Nothing was reverted.
  Every codex number above was measured on 0.146.1. This repeats a warning the `grok-attention-midturn`
  dogfood already records: never send a bare Enter at a runtime selector. Every later driver answers
  only a selector it recognised first.
- The measurements granted trust to scratch directories in the human's own runtime configs.
  `~/.codex/config.toml` gained five `[projects."<scratch path>"]` blocks and four
  `[hooks.state."<scratch path>…"]` blocks. `~/.grok/trusted_folders.toml` gained three
  `[folders."<scratch path>"]` blocks. All twelve were removed afterwards. Both CLIs still parse
  their config. The codex UPGRADE was not reverted, because a downgrade was never authorised.

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- **A2 — the applied record lives at `.tachyon/plugins-applied.json`.** It is a SIBLING of
  `.tachyon/plugins/`, not a file inside it. Every entry inside that directory is a plugin name, and a
  plugin name may contain a dot, so a file placed among them is a name a plugin could take.
- **A2 — presence means applied, and there is no third state.** A contribution named in the record is
  applied. Anything else is not applied. The alternative was an explicit boolean per contribution,
  which adds an "undecided" state that the spec already answered: nothing is applied unless a human
  applied it. Absence being authoritative is also what makes "an un-applied skill must not resurrect"
  true by construction rather than by care.
- **A2 — a missing file is the empty state; a malformed file is an error.** A fresh clone has no
  record and applies nothing, which is the decided default. A corrupt record read as "nothing applied"
  would tell a human every switch is off while the materializations are still on disk. That inversion
  is the failure this spec exists to prevent, so the read throws.
- **A2 — a contribution is `{kind, name}`, and it is runtime-agnostic.** `apply` fans out to every
  runtime the plugin declares, so the human decides per contribution and never per runtime. The
  granularity matches what a removal can name: `engine.ts:1248` records a `settings-hook` target with
  `ref: <event>`, and a `skill-dir` target by its directory name.
- **A2 — only `skill` and `hook` are spellable.** `mcp-server` belongs to Phase C and `view` is out by
  decision. An id naming either fails to parse. A record must not hold a fact that no code can honour.
- **A2 — `forgetPlugin` exists because uninstall owes this record something.** Without it the residue
  has a known shape (`t-17d885`): the roster entry goes and an authority keyed by the same name stays.
  A later re-install would then find contributions already marked applied, and materialize things the
  human never re-chose.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- `plan.md` § Files touched lists `src/plugins/paths.ts` for the applied-record location. A2 put
  `APPLIED_STATE_REL_PATH` in the new `src/plugins/appliedState.ts` instead. `paths.ts` holds
  path-SAFETY helpers plus the two constants a second reader must reconstruct
  (`projectedInputs.ts` rebuilds a skill-dir source from `PLUGIN_PAYLOAD_ROOT`). The applied record has
  no such second reader yet. If A3 or A5 grows one, move the constant then.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- **A1/A1b used real live sessions and real model calls.** A fixture would have been cheap and would
  have proved nothing about a runtime. The cost was real tokens and one accidental CLI upgrade. The
  return was two answers nobody had: claude re-reads hooks live, and codex and grok do not.
- **The codex measurements are deliberately short.** The account showed less than 25% of its weekly
  limit. Each codex session used two or three tiny turns. The skipped case is named under Open
  questions rather than assumed.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- **What does A5 SAY on codex and grok?** A1b proves the honest text cannot be "disarmed". Options are
  a per-runtime state on the card, or a "restart to disarm" affordance, or refusing to un-apply a hook
  while a session of that runtime runs. This is A5's decision and it now has a measurement to obey.
- **Does Tachyon surface the runtime's OWN gate?** Codex holds a hook at `Review` and grok holds one
  behind folder trust. Tachyon's switch cannot arm either. A card that shows only Tachyon's state
  would over-claim. Owner: A5.
- **What happens to the applied record when a plugin UPDATES?** A2 stores contribution names. An
  update may rename or drop a skill, which leaves a stale id in the record. The store keeps the record
  verbatim, because reconciling needs the manifest and the store does not read manifests. A3 owns
  this: apply-time reconciliation, or a prune at update. Neither is written yet.
- **Un-apply while a hook is MID-EXECUTION is safe on all three runtimes, but the reverse is untested.**
  No measurement covers un-applying a SKILL while that skill is executing.

## Phase C — mcp-server apply/unapply (t-7f52f6, 2026-08-12)

### Measurement — does a runtime re-read MCP config mid-session?

_Attempted 2026-08-12 by `mcpapply`. Same discipline as A1b: a live session, a real config change, a
tool result as proof. The live half did not complete on this host._

| Runtime | Plugin MCP path | Live mid-session reread | What was measured |
|---|---|---|---|
| claude 2.1.228 | `.mcp.json` | **not completed** | `claude -p --mcp-config` failed `Not logged in`. `claude mcp list` in the scratch repo **did** discover `probe-token` from `.mcp.json`, as `⏸ Pending approval`. That is a second gate Tachyon cannot open, the same class as Codex hook Review / Grok folder trust. |
| codex 0.146.1 | `.codex/config.toml` `[mcp_servers.*]` | **not completed** | No live session this pass. A1b already showed this runtime freezes its *hook* set at session start; MCP is the same class of startup-loaded config. |
| grok 1.0.3 | **none** | n/a | `ADAPTERS.grok.mcpRel` is null. Plugin MCP never lands in Grok. |

Scratch residue: `/tmp/mcp-probe-server.js`, `/tmp/mcp-reread-mSrZ` (git init + `.mcp.json`). No writes to `~/.claude`, `~/.codex`, or `~/.grok`.

**Consequence for the card:** an un-apply switch must not read "disarmed". The conservative label is
"Restart a running session to drop the tools". A later pass that completes the live reread can
narrow that per runtime, the way A5 must for hooks.

### Design decisions

- **Same store, new kind.** `ContributionKind` grew `"mcp"`. Id `mcp:<kebab>`. No second file. `view`
  stays unspellable.
- **Install records, apply writes.** `buildInstallTargets` still records `mcp-server` targets (so
  apply has the lockfile `removal` identity). `activateInstall` writes a server only when the store
  already says it is applied (an update of a live server). First install leaves `.mcp.json` /
  `config.toml` untouched.
- **Un-merge is the hook form.** `unapplyContribution` / uninstall use `mcpRepEquals(current,
  target.removal)` then `removeMcpServerText`. A human-edited same-name entry is an orphan. A
  never-applied absent entry is not an orphan.
- **Collision at apply, not a silent overwrite.** Apply refuses a same-name occupant that is not our
  recorded removal unless `{ replace: true }`. Install-time Keep/Replace still decides whether the
  lockfile records the target at all.
- **`forgetPlugin` on uninstall.** Re-install must not find MCP servers already marked applied
  (`t-17d885`).
- **Update prunes dropped applied servers.** A version that stops shipping `extra` un-merges it (if
  applied) and `markUnapplied`s it.

### Deviations

- Phase A A3/A4 are still unchecked. Phase C does **not** stop install from materializing skills or
  hooks. Only MCP writes moved behind apply, so a break is attributable.
- Live MCP mid-session reread was not completed (no logged-in `claude -p` on this host). The UI
  uses the conservative restart label rather than inventing a live-disarm claim.

### Open questions left for later

- Complete the live MCP reread on claude and codex (same method as A1b). Owner: whoever next
  touches the card copy.
- Whether apply should surface the runtime's own MCP approval gate (claude `Pending approval`).
  Same shape as A5's hook-gate question.
## Phase A completion — 2026-08-12

- `install` now records `skill-dir` and `settings-hook` targets but materializes neither; the Phase C `applyContribution` / `unapplyContribution` seam is the single apply door for all three contribution kinds.
- Skill apply copies the installed payload to every recorded runtime target. Hook apply uses the lockfile's adapter-rendered removal identity; unapply performs content-based un-merge, so unrelated human settings survive.
- Legacy tests that called `applyInstall` and then asserted a runtime file existed were converted only where A3 deliberately invalidated that premise. One update failure was initially read as a removal-identity divergence; inspection showed the settings file was absent because that test never explicitly applied the hook. A dedicated apply → `previewUpdate` test now proves an unchanged applied hook is not classified as edited.
- The first full gate found one more instance in `sddDogfoodMaterialization.test.ts`; it now explicitly applies `skill:sdd` before checking the two runtime copies.
- A post-gate documentation audit found `docs/runbooks/plugins.md` still teaching install-as-projection. It now names install and apply as separate steps and points the operator to the actionable per-contribution controls.
- Plugins UI now shows installed/applied state and per-contribution controls for skills and hooks. Armed hooks carry conservative restart copy.
- Visual QA passed at 880 and 360: evidence `ev-2026-08-12T21:04:46.412Z-6`.
