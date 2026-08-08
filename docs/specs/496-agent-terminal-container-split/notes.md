# 496 — agent-terminal-container-split — notes

_Created 2026-08-07._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Measurement log (2026-08-07, tree `d7c6e141`)

Every number in `plan.md` comes from one of these. Run them from the checkout root; nobody should
have to re-derive them, and if a number moves, this is where to see which command moved.

```sh
# Raw population of agent/terminal kind tests — 136
grep -rnE '\.kind (===|!==) "(agent|terminal)"|\bkind (===|!==) "(agent|terminal)"' \
  src/ --include=*.ts --include=*.tsx | wc -l

# The narrower grep t-91564a used — 31, of which one is a comment
grep -rn 'kind === "terminal"\|kind !== "terminal"' src/ --include=*.ts --include=*.tsx | wc -l

# TachyonConfig.agents reads — 77 sites / 13 files in src, 199 in test
grep -rnE '\b(config|cfg)\??\.agents\b' src/ --include=*.ts --include=*.tsx | wc -l
grep -rnE '\b(config|cfg)\??\.agents\b' src/ --include=*.ts --include=*.tsx | awk -F: '{print $1}' | sort -u | wc -l
grep -rnE '\b(config|cfg)\??\.agents\b' test/ --include=*.ts --include=*.tsx | wc -l

# Fixtures declaring a terminals: block — 16
grep -rl 'terminals:' test/fixtures --include=tachyon.yml | wc -l

# The only two callers of parseConfig, both of which strip inline agents first
grep -rn "parseConfig(" src/ --include=*.ts | grep -v '^src/config/loadConfig.ts'

# The only callers of the shared Studio serializer/validator — one each, both in studioSubmit
grep -rn "toEntry(\|validateForm(" src/ --include=*.ts --include=*.tsx
```

From 136 to 76: removed `BridgeCaller.kind` (`agent|human|external|master|legacy`), the worktree
registry's `kind` (`agent|change`), the sidebar tree's `context.kind`, the runtime-observability fact
kind, and four comment lines. The classification of the remaining 76 is the table in `plan.md`.

## Design decisions

- **2026-08-07 — the spec's subject changed after measurement.** `t-91564a` is written as a
  type-split task. The type split shipped as SDD 478 M2 and is in the tree. Rather than report the
  premise gone and stop — which `docs/project-guidance.md` allows — the measurement identified a
  real and adjacent defect with the same symptom, the same files and the same owner sentence behind
  it: the CONTAINERS were never split, and that is what produces the branches the task counted. The
  spec is written against the container. The premise correction is stated in `plan.md` § *What the
  measurement changed about the task* rather than buried, because a reader of `t-91564a` will
  otherwise expect a different deliverable.

## Deviations

_None yet — nothing has been implemented._

## Tradeoffs

- **Accessors instead of two maps.** Gives the narrowed type at the call site for 0 of the 276
  `config.agents` touch points. What is given up: `TachyonConfig.agents` keeps a name its own doc
  comment apologises for, and a reader of the type still sees one map. Worth it because the rename
  and the semantic split would otherwise arrive as one unreviewable diff, and because two maps would
  force the agents/terminals namespace-collision rule (`loadConfig.ts:1399-1410`, which drops BOTH
  colliding entries) to be re-implemented at every merge point.

## Open questions

The five in `spec.md` § *Open questions*, all the owner's. Two of them (1 and 2) block slice 3 only;
slices 1, 2 and 5 can start without any answer.

Question 5 — whether a persisted record with no `kind` is an agent or is refused — is a live
contradiction in the tree today, not something this spec introduces:
`resume/SessionLedger.ts:491` refuses it, while `config/configLkg.ts:118`,
`config/configFailure.ts:87`, `webview/ide-browser-bridge/manager.ts:339` and
`validations/validationCloseNotify.ts:125` read it as *agent*. Slice 2 must not silently pick a side.
