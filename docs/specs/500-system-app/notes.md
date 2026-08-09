# 500 — system-app — notes

_Created 2026-08-09. Delivered 2026-08-09 (t-7b92bd)._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### The Workspaces counter, and the one number that could still lie

`overview.workspaceCount` counts the workspaces attached to the WINDOW, deliberately unscoped — t-72ff5a
put it that way because scoping it "would pin it to 1 forever and retire the only number that says a
second project exists". Printed as the Workspaces value above one card, it is exactly the
counter-contradicts-the-cards state `spec.md` § Acceptance forbids, and it is the only real instance of
that contradiction in the model.

So: the **value** is `control.workspaces.length` — the rows on screen, per D3 — and the window's count
survives as a labelled sub-line, `of {N} in this window`, rendered only when it differs. Nothing is lost
by omission and no number describes something other than what it appears to describe. Photographed:
`multi-workspace-window` fixture, where the tile reads `1` over `of 2 in this window`.

### `model.overview` was measured, not deleted

Consumers, at the point of use rather than by text search:

| consumer | reads | verdict |
|---|---|---|
| `model.ts:563-565` `formatCockpitDiagnostics` | `approvalsPending`, `inboxPending`, `worktreesActive` | **live** — three lines of the text a human copies when something is already wrong |
| `system/App.tsx` | `inboxPending`, `worktreesActive`, `workspaceCount` | **live** — the three counts with no per-row source |
| `test/unit/cockpit.test.ts`, `approvalsPendingCount.test.ts`, `cockpitLazyCollect.test.ts` | various | live |

The field stays whole. What changed is that System no longer reads its *derivable* half
(`enginesAttached`/`enginesError`/`agentsRunning`/`agentsTotal`), which `model.ts:529` sets from
`control.summary` — those come from the rows now.

### What a human with an old tab open sees

**Not predicted — the mechanism was read at the point of use.** `tachyonOverview` and `tachyonEngine`
are registered in `extension.ts`'s `registerDisposePanelSerializer` loop, so on the next window reload
VS Code hands the persisted panel back, the serializer disposes it, and the tab closes. No error, no
empty webview, no redirect.

A redirect into System *was* representable (unlike `tachyonFleet`, whose app was deleted outright) and
was rejected: each old tab carries the title and icon of a surface that no longer exists, and reviving
it as System leaves a human holding a tab labelled "Overview" that draws something else. Disposing says
the honest thing. The launcher's one System tile is a click away.

### Visual QA — verdict, and what changed after looking

Anchor written from `spec.md`'s problem statement before the screen was built; captured through the
preview harness's sized iframe at **880 and 360**, against the real shipped bundle. Screenshots in
`.tachyon/visual-qa/sdd-500/` (attached as evidence on t-7b92bd).

| case | fixture | verdict |
|---|---|---|
| before — Overview | `?view=overview` (pre-merge) | metrics + Bridges, ~200px |
| before — Engine | `?view=engine` (pre-merge) | one card + log panel, ~450px |
| one workspace, healthy | `system:default` | **one screen, not two stapled.** 580px total at 880 — the summary is a single 65px row and the card starts immediately under it. No overflow at either width. |
| engine in `error` | `system:engine-error` | **obvious from the top**: `ERRORS 1` toned red in the strip, `Error` badge on the card, failure text in the Engine cell. |
| two roots in the window | `system:multi-workspace-window` | `1` over `of 2 in this window`; one card. No contradiction. |

**Fixed as a result of looking** — one real defect, and it was in the case the screen exists for. At 880
the engine failure text broke mid-word in the narrow Engine column: *"no re / sponse on 127.0.0.1:7421
after 5s"*. Cause: `.ci-kv .v { word-break: break-all }` in the shared `engine-workspace.css`. That rule
is right for the other eleven values in those cells (root path, hash, bundle id, url — all tokens where
mid-token breaking is what you want) and wrong for the one value that is prose, which is the one a human
reads when something is already broken. Changed to `overflow-wrap: anywhere`: a token too long for its
column still breaks, so nothing overflows, but a word that would fit on a line of its own is left whole.

`engine-workspace.css` is a SHARED sheet, so the neighbours were measured before and after as well —
Worktrees and Settings link it, at both widths. All four captures are **byte-identical** across the
change (neither surface uses `.ci-kv`), so the fix is contained to the surface that motivated it.

Density verdict: the risk named in Open question 3 does not materialise in either of its forms. The
summary costs one row, and there is no second workspace to push anywhere.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### D4 is cancelled — there is no collapse rule, and that is a decision

`plan.md` § D4 said: one workspace expanded, more than one collapsed, an engine in `error` expanded
regardless. It is not implemented, and it is not an omission.

**Measured before writing any of it.** `buildCockpitModel` (`model.ts:439-440`) does:

```ts
const selected = requested ?? workspaces[0]?.hash;
const scoped = selected ? bundles.filter((b) => b.control.wsHash === selected) : bundles;
```

With at least one bundle, `selected` always resolves, so `scoped` holds exactly one — and
`control.workspaces` is built from `scoped`. There is one bundle per workspace, so **`control.workspaces`
is 0 or 1, always.** The Engine screen has been mapping a one-element array since t-72ff5a removed the
"All workspaces" aggregate. A second card cannot exist, so the second workspace could never fall below
the fold.

Owner ruling (t-7b92bd journal, 2026-08-09): do not ship the rule anyway. A branch that only a test
fixture can reach is machinery with no tap — the class swept out of this repo the same morning
(t-e50995 found five, the worst of which promised recovery on restart and never ran). If multi-root
scope ever returns, the rule gets written against the real case in front of it.

`spec.md`'s Open question 3 partly dissolves with it. The density risk that remains is a different one:
a summary too tall pushing the single real card down. That is what the Visual QA pass above attacked.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

### The Bridges panel is gone (removed fact: none)

Overview carried a `Bridges` list — folder, url, and a ✓/! reachability mark, one line per workspace.
It is not on System, and every fact it held is on the card immediately below where it used to sit: the
folder name and hash are the card's header, the ✓/! is the state badge beside them, and the url (plus
port, instance and auth, which the list never had) is the Bridge sub-card. It was a second rendering of
the same rows, and page height is the one budget this screen cannot overspend. `bridges` left
`CockpitStrings` with it.

### All four actions survived

Auto-refresh, Refresh and Copy diagnostics came from Overview; Run Doctor came from Engine. All four are
on the merged action row and all four are answered by `SystemPanel`. Nothing was dropped, so `spec.md`
§ D5's "record which and why" has nothing to record.

Auto-refresh is the union's answer to a real disagreement: Overview polled under a toggle, Engine polled
unconditionally. The toggle wins — it is the one that can also be turned off.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None left open by this delivery. `spec.md`'s three are answered above: question 1 by D1's resolving
alias (no fallback in `route.ts` was touched), question 2 by D2 plus the observed dispose behaviour,
and question 3 by the measurement that cancelled D4 plus the Visual QA pass that attacked what was
left of the density risk.
