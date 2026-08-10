# t-be359b — `vscode.window.showQuickPick` sweep: verdict per site

Owner's policy, 2026-08-09: *"não queremos isso no projeto, nós criamos nossos próprios pickers."*
This document is the measurement behind that sweep — **a verdict for every site, including the ones
that stay native**, with the reason also written at the call site so the next reader does not mistake
a decision for an oversight.

Measured on this worktree at `HEAD 8d32e793`, after `t-ea5425` landed.

## The count is 12, not 13

The task title says 13. It is wrong, and it was already wrong when it was written: the enumeration in
the task body lists eleven `extension.ts` lines plus `notify.ts:34` — twelve. A `grep -c` reports
**15**, because three of the hits are *comments* that name the API rather than call it
(`webview/activity/App.tsx:401`, `webview/shared/ui/QuickPicker.tsx:2`,
`webview/activity/messages.ts:74`).

| count | value | why it differs |
|---|---|---|
| raw `grep -c showQuickPick` in `src/` (non-test) | 15 | includes 3 comments naming the API |
| actual `vscode.window.showQuickPick(` call sites | **12** | 11 in `extension.ts`, 1 in `notify.ts` |
| in scope for this sweep | **11** | `extension.ts:679` is `t-ea5425`'s, excluded by contract |

## The question that decides each verdict

Not "is this a picker?" but **"at the instant the human is asked, is one of our surfaces on screen,
and does it have the candidate set?"** A picker of ours with nowhere to draw is worse than the native
one. So each site is classified by its **doors** — every actor × trigger that can reach it — because
one function is routinely reached by a webview *and* by the Command Palette, and those two doors get
different answers.

- **Case 1** — a webview of ours is open and can host the picker → convert (mould: `t-ea5425`).
- **Case 2** — reached only without a surface of ours (Command Palette / background) → stays native.
- **Case 3** — chooses a folder *before* the surface or workspace exists → stays native.

## The table

| # | site | question asked | doors that reach it | case | verdict |
|---|---|---|---|---|---|
| 1 | `workspace/notify.ts:34` | notification's action choice | **any** `showNotification` with actions, from any command, any background flow, any workspace event | 2 | **stays native** |
| 2 | `extension.ts:494` `pickWorkspace` | Which folder? | 17 callers, all shaped `hash ? byHash(hash) : await pickWorkspace()` | 2 | **stays native** |
| 3 | `extension.ts:546` | which prompt template | agent-pane webview (2249) · palette (3754) · tree item (3760) | 1, **blocked** | stays native — see *What the primitive is missing* |
| 4 | `extension.ts:564` | which agent to send to | palette only — the webview door always preselects | 2 | **stays native** |
| 5 | `extension.ts:572` | stage or submit | agent-pane webview (2249) · palette (3754) · tree item (3760) | 1, **blocked** | stays native — see below |
| 6 | `extension.ts:679` | which changed file | sidebar agent row · pipeline "View changes" · Worktrees webview | — | **out of scope** (`t-ea5425`; guard `singleDiffReviewImplementation.test.ts`) |
| 7 | `extension.ts:964` `pickAgent` | which agent | 3 callers (3331, 3808, 3821), each a bare palette command | 2 | **stays native** |
| 8 | `extension.ts:995` | which runtime connects to the Bridge | 1 caller (3888), bare palette command | 2 | **stays native** |
| 9 | `extension.ts:2645` | Which folder? (configured) | **sidebar webview** (`studio:*`) · palette (6 commands) | **1** | **CONVERTED** |
| 10 | `extension.ts:2659` | Which folder? (bootstrap) | palette · sidebar — but see below | 3 | **stays native** |
| 11 | `extension.ts:3148` | Initialize Tachyon where? | palette · sidebar `init` button | 3 | **stays native** |
| 12 | `extension.ts:3445` | Run which pipeline? | 1 caller (3436), bare palette command, after `pickWorkspace()` | 2 | **stays native** |

### Count, before → after

| | before | after |
|---|---|---|
| `vscode.window.showQuickPick(` call sites in `src/` (non-test) | 12 | 12 |
| of those, reachable when a surface of ours is on screen | 1 | **0** |

The call count is deliberately unchanged and is **not** the measure. Site 9 keeps its native branch
because the same command is still reachable from the Command Palette, where nothing of ours is
drawn. What changed is that the door which *does* have a surface no longer reaches it: the sidebar
answers the question in our chrome and passes the result. The honest measure is the second row —
after this sweep, no human is shown a VS Code quick pick while one of our surfaces is on screen and
holds the candidates.

### Why 10 and 11 look convertible and are not

Both are reachable from the sidebar, so the door test alone would call them case 1. The **candidate
set** test is what separates them: they offer *unconfigured* `workspaceFolders` — folders with no
`tachyon.yml`, therefore no `FleetVM`, therefore no row in any webview model we ship. And both
branches run only when **zero** folders are configured, which is precisely when the sidebar is
showing its "Initialize Tachyon" welcome rather than a fleet. There is nothing on screen to list and
nothing in the webview to list from. This is the case-3 the task predicted, confirmed rather than
assumed.

## Why the case-2 verdicts are structural, not lazy

`pickWorkspace` is the clearest case, and it generalises. Every one of its seventeen callers has the
shape `hash ? byHash(hash) : await pickWorkspace()`. When a webview or a tree item invokes the
command it **passes the hash**, and the picker never runs. The picker is the fallback that exists
*precisely because* the caller had no surface to say which workspace it meant. Converting it would
mean drawing our chrome in a window where, by construction, none of our surfaces is showing.

`pickAgent`, `connectRuntime` and the pipeline picker inherit this: each sits behind a bare
`registerCommand` whose first act is `await pickWorkspace()`, so reaching them at all already proves
the palette door.

`notify.ts:34` is different in kind and the most important one to leave alone. It is not "a picker" —
it is how spec 415 renders a *notification with actions* without going through Notification Center.
It is reachable from anywhere in the extension, including background flows with no window focus.
Converting it is a cross-cutting authority change, not a picker swap.

## What the primitive is missing (sites 3 and 5)

These two are the only ones where the honest answer is "there is a surface, and we still cannot draw
there **today**" — and the brief asked for what is missing rather than a second picker.

The template/mode picks are reachable from the **agent pane webview** (`openTemplateInject`,
`extension.ts:2249`). That is a real surface. But `AgentPanePanel.ts:161` deliberately withholds the
design system:

```ts
// No design-system.css: Tachyon Mono @font-face breaks xterm cell metrics.
styles: [uri("xterm.css"), uri("agent-pane.css")],
```

`QuickPicker.tsx` renders `ds-qp-*` classes, and **every one of those rules lives only in
`design-system.css`** — together with the `--ds-fg / --ds-muted / --ds-border / --ds-focus /
--ds-hover / --ds-ok / --ds-warn / --ds-err / --ds-scrim / --ds-z-dialog` tokens they read.
`agent-pane.css` defines the spacing tokens `--ds-1..4` and **none** of the colour tokens.

So the gap is packaging, not design: **the QuickPicker's styles are not separable from the
`@font-face` that this surface must not load.** Fixing it means moving the `.ds-qp*` block and its
token subset into a sheet an xterm surface can link without the font — a change to a shared asset
every surface consumes, which needs before/after visual evidence on the neighbours and is not this
sweep's smallest coherent change. Filed as **`t-de3dfc`**; not hacked around here, and no second
picker was written.

That task also carries a hazard to *measure* rather than assume before it closes: `QuickPicker`
registers `keydown` on `document` in the capture phase, and the agent pane is a live xterm that
forwards keys to a tmux session.

## Note recorded, not acted on

The two `showInputBox` calls (`extension.ts:3563`, `3705`) are out of scope by contract; the PR one is
`t-f3ded3`.
