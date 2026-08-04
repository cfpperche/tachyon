# 488 — Adversarial architecture review

**Review commissioned by the human maintainer (via grok dispatch). Reviewer: claude.**

Date: 2026-08-04 · Branch `tachyon/grok` · Read-only pass · Lenses: architecture, code structure, artifact location, widget stack.

---

## Verdict

**Merge with structure follow-ups — but ratify one architectural fact first, because the memo does not describe the system that was built.**

The product works and was dogfooded, the engine-side client is careful, and the theme-token strategy is genuinely good. I am not asking for a restructure before merge: the widget stack is the largest cost in the tree and rewriting it pre-merge would trade a working, exercised surface for an unexercised one.

But `architecture-fit.md` frames this as **two bridges**, and the diagram (`architecture-fit.md:19-30`) traces only the agent→page direction. The product's PRIMARY direction — human types in Design Mode chat → agent receives it — goes through **neither bridge**. It is `ws.activity.sendAgentInput(...)` at `manager.ts:486`, which resolves to `sendManagedAgentInput` → tmux `sendKeys` (`agentInputService.ts:31-45`). The shell types into the agent's terminal.

That is a defensible design — it is how `notify_agent` reaches an agent too — but it is a **third path**, it is the one the spec calls "the sole agent channel", and the reviewer checklist asks people to agree to a diagram that omits it. Fix the memo, then merge. Everything else here is follow-up work.

---

## Findings

| id | sev | lens | claim | evidence | recommendation |
|---|---|---|---|---|---|
| **A1** | **P0** | arch | The human→agent hop bypasses both bridges: it is pane injection via tmux `sendKeys`, not MCP and not the shell HTTP bridge. The fit memo's diagram shows only agent→page and the checklist asks reviewers to ratify it. | `manager.ts:486`; `agentInputService.ts:31-45`; `architecture-fit.md:19-30`, `:84` | Redraw the diagram with three paths and name the third. Do not change the mechanism for this merge. |
| **A2** | **P1** | arch | Design Mode's send has no human-draft protection, while the sibling agent→agent path holds delivery when the recipient's composer has a draft. A chat send can concatenate onto a half-typed human line and submit both. | `agentInputService.ts` has no `draft`/`composer`/`held` term; contrast `tools.ts:4214` (`held-human-draft`) | Verify against a pane with a draft. If it clobbers, route Design Mode through the same guarded path or state the gap in the spec. |
| **A3** | **P1** | arch | The memo says "This mirrors Companion: thin shell + engine authority" — but at the one seam where Companion protects the agent's tool catalog, 488 inverts it. Companion gates on a human setting *specifically to avoid "list pollution"*; IDE Browser is always registered. The two lines are adjacent. | `Workspace.ts:1786` vs `:1790`; `tools.ts:355-358` ("Absent/false → tools omitted (no list pollution)"), `:3619-3628` | Either gate 488 the same way, or delete "mirrors Companion" and argue the asymmetry on its own merits. Do not claim the mirror while inverting it. |
| **A4** | **P1** | arch | Three browser tool families now share the agent's catalog with overlapping verbs (`navigate`, `screenshot`, `eval`, `click`) and no disambiguation in the descriptions beyond one "Prefer this for UI preview inside VS Code". An agent choosing between `user_browser_navigate` and `ide_browser_navigate` has one adjective to go on. | 14 `ide_browser_*` vs 97 `user_browser_*` occurrences in `tools.ts`; `tools.ts:3651-3655` vs `:2925-2927` | Each family's description should open with WHICH browser and WHOSE session, in one clause. Cheap, and it is the "naming" item B1 already anticipates. |
| **S1** | **P1** | stack/structure | `designModeInject.ts` is 1720 lines of which **~1656 (96%) are JavaScript inside one template literal** (`:63`–`:1719`). It is an application with no type checking, no linting, and no executable test. Every one of its 30+ tests is a string grep over the generated source. | `designModeInject.ts:47`, `:63`; `designModeInject.test.ts:124-127` | See the stack decision. Immediate mitigation below. |
| **S2** | **P1** | structure | The test named *"picker toggle arms/disarms and hides card when off"* asserts only `expect(src).toContain("setPickMode")` and `toContain("hideCard")`. It passes if the function is defined and never called, or called with inverted logic. Several sibling tests have the same shape. This is coverage that cannot fail for the reason it claims. | `designModeInject.test.ts:124-127` | Do not trust these as behavioural coverage when judging merge risk. Name them for what they assert ("the inject source declares X") or make them executable (see stack decision). |
| **X1** | **P1** | stack | Host→page delivery races the re-inject and is handled with a 5× retry loop whose comment names the race: *"re-inject may not have installed `__tachyonDmChatPush` yet"*. The repo already solved this problem with a READY handshake in `SectionPanelManager`; the string-inject stack cannot use it, so it guesses. | `cdpSession.ts:470-473` | Structural argument for the hybrid stack, not a patch. A retry loop is a handshake nobody could write. |
| **S3** | **P2** | structure | `manager.ts` (1062 lines) is an HTTP server, a CDP client, the chat controller, a screenshot writer, an auth checker and the design-agent registry. `http.createServer` at `:116` sits in the same class as `ingestChatReply` at `:676`. | `manager.ts:38`, `:116`, `:291`, `:676`, `:792` | Split by seam, transport first: `httpServer.ts` (routes + auth) and `designModeController.ts` (chat/pick/agent). The CDP half already lives in `cdpSession.ts` and that split works. |
| **L1** | **P2** | location | `dogfoodBootstrap.ts` (195 lines) sits in the production shell path with **zero importers**, and its own header says "it is not registered on activate". | `dogfoodBootstrap.ts:1-8`, `:46`; no importer outside itself | Move to `test/` or `scripts/`, or delete. Dev-only scaffolding in `src/webview/` invites the next reader to wire it. |
| **L2** | **P2** | location | Every pick payload ships a runbook AND an auth troubleshooting guide as prose, including engine-side token semantics ("401 / token_unknown … Tachyon heals live process tokens"). Shell code is teaching agents how the Bridge's auth works, and one line exists to talk agents out of an artifact location (*"do not dig for `~/.tachyon/ide-browser-instances/`"*). | `pick.ts:181-195` | The location line is prose defending a boundary — make the boundary hold instead (L3). Move the failure-mode guide into the tool descriptions where the failure occurs; keep the pick payload to the pick. |
| **S4** | **P2** | structure | `ideBrowserToolsEnabled` is `@deprecated … Kept for tests that gate registration without a request fn` — a production dep kept alive so tests can take a path production does not. It is also still wired in `Workspace.ts` for "status probes". | `tools.ts:361-366`; `Workspace.ts:1789` | Give the tests a real `ideBrowserRequest` stub and delete the second gate, or make it non-deprecated with a stated purpose. A dual path kept for tests is the shape that hides a divergence. |
| **L3** | **P3** | location | `~/.tachyon/ide-browser-instances/` (global) and `.tachyon/design-mode-chat/chat.jsonl` (workspace) are both correctly placed against existing convention — global home is already used for genuinely cross-workspace state, and the workspace `.tachyon/` already holds `approvals.jsonl` / `agent-proposals.jsonl`. Chat file mode is `0o600`. | `client.ts:24-25`; `designModeChat.ts:65`, `:148`; `globalSettings.ts:35`, `engineBundleStore.ts:105` | Keep. No move needed before main. |

---

## Artifact map — ideal vs current

| Artifact | Current | Ideal | Verdict |
|---|---|---|---|
| Instance discovery | `~/.tachyon/ide-browser-instances/` | same | **Right.** Genuinely cross-workspace: an agent in a worktree must find a shell it does not share a root with. Matches `globalSettings` / `engineBundleStore`. |
| Design Mode chat log | `.tachyon/design-mode-chat/chat.jsonl` | same | **Right.** Workspace-scoped, beside `approvals.jsonl`. `0o600`. |
| Pick screenshots | written by `manager.writePickScreenshot` (`:291`) | evidence channel (spec 273) or keep | **Fine for v1.** Worth asking later whether a pick screenshot is evidence; the store already exists. |
| Engine client | `src/ide-browser/{client,protocol}.ts` | same | **Right.** Engine-side, dependency-light, no vscode import. |
| Shell bridge | `src/webview/ide-browser-bridge/*` | `src/ide-browser-shell/*` | **Move later.** It is not a webview — no `main.tsx`, no panel, no bundle entry. Living under `src/webview/` misfiles it for every future reader, and this repo just spent a spec learning what a directory named for the wrong owner costs. |
| Dogfood bootstrap | `src/webview/ide-browser-bridge/dogfoodBootstrap.ts` | `scripts/` or `test/` | **Move before main.** Zero importers, self-described as not registered (L1). |
| MCP tools | `src/bridge/tools.ts` (+14 sites in a 5995-line file) | same for now | **Fine.** The god-file is a known separate problem (`t-3b47ad`); do not let 488 be the one asked to fix it. |
| Spec | `docs/specs/488-…` | same | **Right.** |

---

## Widget stack — A / B / C / D

**Merge now: A (keep the string inject), capped.**
**Post-merge target: D (hybrid) — thin in-page pick, webview chrome.**

| | Verdict | Why |
|---|---|---|
| **A** — string/IIFE inject | **Keep for merge. Reject as the destination.** | It works and is dogfooded, and swapping it pre-merge trades an exercised surface for an unexercised one. But 96% of the file is untypechecked, unlintable, unexecutable-in-test source (S1), its behavioural tests are string greps (S2), and it cannot have a ready handshake, which is why a retry loop stands in for one (X1). |
| **B** — Preact/React bundle injected into the page | **Rejected.** | Buys type checking and real component tests, and pays a migration — but keeps every property that makes in-page hard: Trusted Types policies, host-page CSP, style collisions, re-inject on every navigation, and no VS Code theme vars (which is why `themeTokens.ts` exists at 362 lines to simulate them). Pays the cost, keeps the hazards. |
| **C** — pure VS Code webview | **Rejected as a whole.** | Cannot do the one thing Design Mode is for. Element hover, hit-testing and selection must execute *in the page*; no webview can reach the third-party DOM. Correct for the chrome, impossible for the pick. |
| **D** — hybrid: thin inject for pick, webview for chat/card | **The destination.** | Splits along the line the constraint actually draws. The in-page half shrinks to hover/hit-test/outline/serialize — the part that MUST be in the page and is the part best served by a small script. The chrome half moves to a webview and inherits what the repo already built: `--vscode-*` vars for free (deleting the reason `themeTokens.ts` exists), `design-system.css` and `shared/ui`, `SectionPanelManager`'s visibility gate and READY handshake (deleting X1's retry), and components that execute under test. |

**Sequencing.** D is not one migration; it is two, and the second is cheap once the first lands:

1. **Chat + card → webview.** Largest win, smallest risk: chat is already a JSONL-backed list, which is exactly what a `SectionPanelManager` document renders. This is where the theme code, the retry loop and most of the 1656 string-lines go away.
2. **Pick overlay stays inject, and shrinks.** Target a few hundred lines whose whole job is: hover outline, click capture, serialize, post over the binding. That size is reviewable as a string; 1656 is not.

**Cap for merge now (cheap, do it in this PR):** add a source-size budget test on `designModeInject.ts` the way `panelSourceForm.test.ts` budgets panel hosts, with the current number as the ceiling and the reason written down. It costs one test, and it stops the file growing while D is scheduled. This repo's own record is that "keep this small" fails as prose and holds as a test.

---

## Two-bridge fit

**Keep the two bridges. Do not unify. But stop calling it two.**

The split is right for the reasons the memo gives, and I did not find a cheaper shape: one process couples engine lifetime to extension-host reload, and agent-native CDP duplicates agent-browser while losing the shared viewport. Agents never call the shell bridge directly, and `client.ts` is disciplined about it — `operatorHomedir()` (`:13-22`) handling a runtime that rewrites `$HOME` is the kind of measured detail that earns trust in the rest.

What needs to change is the **description**, not the topology (A1). There are three paths:

```
agent → MCP → Tachyon Bridge → HTTP → IDE Browser Bridge → CDP → page     (agent acts)
page  → CDP binding → shell manager → chat.jsonl                          (human speaks)
shell → sendManagedAgentInput → tmux sendKeys → agent pane                (human reaches agent)  ← omitted
```

The third is the product's headline channel and it is the one no diagram shows.

| Move | Cost | Recommendation |
|---|---|---|
| Redraw the memo with three paths; rename B1 to cover it | **S** | Do before merge. It is a doc change and it is what reviewers are being asked to ratify. |
| Gate `ide_browser_*` like Companion, or drop the "mirrors Companion" claim | **S** | Do before merge — it is one line either way, and the current text asserts a symmetry the code contradicts. |
| Route human→agent through a guarded seam (draft-aware, like `notify_agent`) | **M** | Post-merge, after verifying A2 reproduces. |
| Unify the bridges into one process | **L** | Do not. The memo's rejection is correct. |

---

## Top 5 structural actions (ordered)

1. **Fix the memo before ratification** (A1, A3) — three paths, and either gate the tools or drop the Companion claim. S, and it is the only thing I would hold merge for.
2. **Cap `designModeInject.ts` with a size-budget test** (S1) — one test, stops the bleed while D is scheduled.
3. **Verify the draft-clobber risk** (A2) — send a Design Mode chat at an agent whose composer holds a half-typed line. If it corrupts, that is a P0 the day someone hits it; if it does not, write down why.
4. **Move `dogfoodBootstrap.ts` out of `src/`** (L1) and rename the shell dir out of `src/webview/` (artifact map). Pure moves, no logic.
5. **Split `manager.ts` on the transport seam** (S3) — `httpServer.ts` + `designModeController.ts`. The `cdpSession.ts` split already proves the shape works here.

Then schedule **D step 1** (chat/card → webview), which retires X1, most of `themeTokens.ts`, and the majority of S1 in one move.

---

## What is solid — keep

- **`src/ide-browser/client.ts`.** Small, engine-side, no `vscode` import, and `operatorHomedir()` (`:13-22`) handles a runtime rewriting `$HOME` — a failure mode most code discovers in production.
- **`themeTokens.ts`.** The three-step no-flash strategy (seed from `ColorThemeKind` → warm via probe → inject always reads cache, never blocks) is well reasoned and honest about why it exists. It should eventually be deleted by moving the chrome into a webview — that is a compliment to the analysis, not a criticism of the code.
- **`cdpSession.ts` as a separate seam.** Extracting the CDP protocol from the manager was the right cut and it is the template for S3.
- **The internal-vs-address-bar navigation policy** (`cdpSession.ts:266-267`): link/form navigation re-injects, address-bar navigation turns Design Mode off. That is a product judgment about intent, not a technical default, and it is the right one.
- **Tool-only replies.** No marker happy path — `design_mode_chat_reply` is the single agent→human door. That contract is why the chat has one shape instead of two.
- **Chat as append-only JSONL at `0o600`** (`designModeChat.ts:148`). Durable, greppable, and it is what makes step 1 of the hybrid stack easy.
