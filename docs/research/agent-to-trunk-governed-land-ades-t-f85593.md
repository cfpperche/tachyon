# What ADEs put between the agent and the trunk

**Task:** `t-f85593`  
**Author:** adescan  
**Date:** 2026-08-08  
**Scope:** research only — no product code, no open SDD  
**Question (not “how to build a PR screen”):** what sits between agent work and the trunk, and what does the human get with one click?

This document answers five questions per tool:

1. Is **merge** executed by the app, or delegated to the forge (GitHub/GitLab)?
2. What does the app **assert** before offering merge, and what does it leave unasserted?
3. Is there **agent review** before the human? Does it **block** or only **advise**?
4. What happens on **conflict** — resolve, or hand back?
5. Does agent work become a **PR always**, or only when asked?

**Evidence discipline.** Each claim is tagged **Verified** (primary docs or Tachyon source) or **Marketing / secondary** (blog, third-party roundup, forum). An explicit **Not verified** list is at the end. Product marketing describes intent; it does not prove runtime behavior.

---

## 1. Framing: what the owner saw, and what Tachyon does today

### 1.1 The screen the owner described

In-app **Pull requests** next to Board / running tasks; list buckets roughly *Need you / In progress / Drafts*; detail pane with **Summary / Conversation / Code**, reviewers, **named CI checks with status**, conflict with main, file count, **Merge**.

**Best match (Verified, docs):** [Devin Review](https://docs.devin.ai/work-with-devin/devin-review) at `app.devin.ai/review` — open PRs “organized by category (assigned to you, authored by you, review requested)”; workflow actions include **Merge**, close, draft/ready, **auto-merge**; merge bar “reflects the PR’s current mergeability status and required checks.” Portuguese labels (*Precisam de você / Em andamento / Rascunhos*) fit a localized UI of that pattern; the labels themselves were **not** confirmed against a live product session.

**Plausible alternate (Verified, partial):** Cursor Cloud Agents also surface PR create / auto-merge / merge cards on agent sessions (forum + product behavior reports). Cursor’s own docs are thinner on a dedicated “PR inbox” next to a Board than Devin’s; **not verified** whether Cursor’s IDE/web sidebar matches the owner’s buckets 1:1.

### 1.2 Tachyon baseline (Verified in this tree)

| Surface | Role |
|--------|------|
| `src/worktree/land.ts` | **Suggest-and-copy** only. Probes five preconditions; if all green, composes `git -C <primary> merge --ff-only <sha>` for the clipboard. **Never executes merge.** |
| Guard | `test/unit/landCommandNeverExecuted.test.ts` — no `src/` git call may pass `merge` or `--ff-only`. |
| Preconditions | `worktree-clean`, `verified-tree` (tree-keyed verify record), `fast-forward` (trunk ancestor of HEAD; unmeasured ≠ false), `primary-on-trunk`, `primary-clean`. |
| Pin | Command names a **commit**, not a branch tip — stale panel cannot silently re-point. |
| `src/worktree/pr.ts` | Optional **open PR** via `gh` from a worktree: readiness (GitHub remote, `gh` authed), dirty warning, body carries verify badge. Human confirms at the publish gate. **Not** the default land path. |
| `src/worktree/review.ts` | Local **diff helpers** (name-status parse, empty sides) for worktree↔base review UI — not forge PR review, not agent review. |

**Product stance (comments + project guidance):** agents deliver to the edge of a worktree branch; a human integrates. `t-7cb971` is the open product question of a governed land door “in the shape of Forget” — agent prepares, human executes. Land suggestion is the half that is correct whether or not the product ever mutates trunk.

**What Tachyon deliberately does *not* assert today:** design correctness of the diff, CI on a remote forge, human/code-owner approval, security review, that the parent agent “signed off,” occupancy of the worktree (alive agent is allowed; sha pin covers moving HEAD).

---

## 2. Comparison tables (five questions)

Legend: **V** = Verified primary; **M** = marketing/secondary; **—** = not verified / not applicable.

### 2.1 Merge: who executes?

| Tool | Who runs merge? | Evidence |
|------|-----------------|----------|
| **Tachyon** | **Neither app nor forge.** Human pastes a suggested local `git merge --ff-only <sha>` (or merges by hand). Product refuses to run it. | V: `land.ts`, `landCommandNeverExecuted` |
| **Devin Review** | **App triggers forge merge** (GitHub/GitLab API) with repo merge strategy; auto-merge toggle on GitHub App connections. | V: Devin Review docs, “PR Workflow Actions” |
| **Cursor Cloud Agents** | Merge / enable auto-merge **from agent/PR UI** when a PR exists; still subject to GitHub. Create-PR is configurable (always vs push-branch-only). | V: Cursor forum staff replies on mobile auto-merge; M: blogs “story ends at PR” |
| **GitHub Copilot cloud agent** | **Human merges on GitHub** (standard PR merge box). Agent has no general write to default branch; works on its branch / PR. | V: GitHub docs + engineering posts (agent limited to own branch) |
| **Claude Code** | Local/CLI or GitHub Action opens branch/PR; **human merges on forge**. Managed Code Review does not merge. | V: Claude Code Code Review + GitHub Actions docs |
| **OpenAI Codex** | Cloud agent opens/creates PR; human merges. Code Review posts reviews, does not own merge. | V: Codex GitHub review docs; M: third-party “create draft PR” UI notes |
| **OpenHands** | Agent can open PRs; human merges. Review workflow posts comments; automation prompt can **APPROVE / REQUEST_CHANGES** as a bot account (GitHub review events — not “merge”). | V: OpenHands PR review docs |

### 2.2 What is asserted before “offer merge”?

| Tool | Asserts (before merge is offered or safe) | Leaves unasserted |
|------|-------------------------------------------|-------------------|
| **Tachyon** | Worktree clean; **this tree** has a verify record; local trunk is ancestor of HEAD; primary on trunk and clean. Fail-closed: unmeasured → blocked. All-or-nothing: no command if any red. | Diff quality; design; remote CI; reviews; that agent intent matches task |
| **Devin Review** | Forge **mergeability** + **required checks** (shown on merge bar); stack readiness for stacked PRs. | That Bug Catcher findings are complete; that human read the code; local verify gate of Tachyon’s kind |
| **Cursor** | Forge state when PR card exists (auto-merge needs a real PR). Bugbot is a separate review product on the PR. | Local tree attestation; whether Cloud Agent tests equal repo gate |
| **Copilot cloud agent** | Normal GitHub merge rules (branch protection, required checks, required reviews). Extra: Actions on agent PRs often need **“Approve and run workflows”** (privilege boundary). | Agent quality; Copilot code review is not a required approval |
| **Claude Code Review** | Posts findings + check run; check run is **neutral** and **does not block** branch protection by default. | Correctness of “Important” findings; human still decides |
| **OpenHands review** | Posts priority-labeled comments; optional bot APPROVE/REQUEST_CHANGES. | Whether APPROVE reflects repo policy or model judgment |

### 2.3 Agent review before human — block or advise?

| Tool | Agent review | Blocks merge? |
|------|--------------|---------------|
| **Tachyon** | No first-party agent PR reviewer. Parent agent (e.g. claude) is the *de facto* human-side reviewer by convention, not product. | N/A |
| **Devin Review** | Auto-review (PR open / push / ready); Bug Catcher + security; optional Auto-Fix proposals. CLI can review from local worktree. | **Advise** by default. Can post GitHub **status checks** if enabled — then branch protection *may* block if you configure it that way (protection is forge policy, not Devin-only). |
| **Cursor Bugbot** | Auto or comment-triggered (`cursor review` / `bugbot run`); Autofix modes. | **Advise** (GitHub comments). Not claimed as required approval. |
| **Copilot code review** | Manual or automatic; always leaves a **Comment** review, never Approve / Request changes. | **Explicitly does not block**; does not count toward required approvals. **V** |
| **Claude Code Review** | Multi-agent PR review; severity tags; check run always **neutral**. Docs: to gate merge, parse severity in *your* CI. | **Advise** unless you wire your own gate. **V** |
| **Codex Code Review** | `@codex review` / auto; posts GitHub review. | **Advise** (standard GitHub review — policy is repo’s). |
| **OpenHands** | GHA or Automation; can submit APPROVE / REQUEST_CHANGES as bot. | **Can block only if** bot is a required reviewer / CODEOWNERS-style policy — product offers the event, forge policy decides. |

**Cross-cutting Verified pattern:** every managed “AI code review” product documents itself as **advisory** relative to branch protection. Blocking is always an **extra configuration** (required check, required human, required bot identity) — never “the AI approved so merge is authorized.”

### 2.4 Conflicts

| Tool | Behavior | Evidence |
|------|----------|----------|
| **Tachyon** | Fast-forward impossible → land check **red**; fix text: integrate trunk into branch and **re-verify**. No auto-resolve. | V: `land.ts` |
| **Devin** | Merge bar / stack dots show conflict red; stacked merge is atomic bottom-up when ready. **Not verified** that Devin auto-resolves ordinary conflicts without a session. Marketing/LinkedIn claim stacked PRs “handle … conflicts” — treat as **intent**, not measured here. | V mergeability UI; M stack claims |
| **Cursor** | Agents can be asked to fix CI / follow up on PR; conflict resolution not primary-doc measured here. | — |
| **Copilot cloud agent** | **“Fix with Copilot”** on merge conflicts; or `@copilot resolve…`. Agent resolves, re-runs tests/linters, **requests human review** before merge. | V: GitHub docs |
| **Claude / Codex / OpenHands** | Typical path: comment the agent on the PR to fix conflicts (pattern documented for OpenHands culture; Copilot explicit). | Mixed V/M |

### 2.5 Does agent work always become a PR?

| Tool | Default delivery object |
|------|-------------------------|
| **Tachyon** | **Worktree branch + commits.** PR is **opt-in** (`pr.ts` / human). Land is local FF, not PR. |
| **Devin** | Cloud sessions commonly end in **PRs** on connected forge (product centered on PR review). Exact “always vs ask” depends on session/settings — **not fully verified** without product session. |
| **Cursor Cloud Agents** | Configurable: auto-create PR on completion vs push branch only (dashboard “Create PRs”). Local Agent/Composer can stay in working tree without PR. | V: staff forum on Create PRs setting |
| **Copilot cloud agent** | Often opens PR / draft PR (assign issue, seed repo, `/task`); can push to branch without PR depending on prompt. | V: GitHub docs |
| **Claude Code** | Local by default (working tree); GitHub Action / `@claude` can open PR. | V |
| **Codex** | Cloud path oriented to PR create (including draft). CLI is local. | V/M |
| **OpenHands** | Can open PR autonomously in cloud demos; not mandatory for local Canvas. | M + docs mix |

---

## 3. Devin Review (deep dive — likely the screen the owner saw)

**Verified from [docs.devin.ai/work-with-devin/devin-review](https://docs.devin.ai/work-with-devin/devin-review):**

- **Inbox:** open PRs by category (assigned / authored / review requested).
- **Review surface:** smart diffs, copy/move detection, Bug Catcher, security, chat over PR + codebase, comments/approve/request-changes **synced to GitHub/GitLab**.
- **One-click (human principal, forge actuator):** Merge, close, draft/ready, auto-merge (GitHub App). Merge button reflects **mergeability + required checks**.
- **Agent review:** auto-review on open/push/ready (configurable); optional CI status checks from Devin; Auto-Fix proposes commits as Devin bot after human enablement.
- **Attribution:** bot findings as Devin bot; human comments as human; chat-applied code as Devin bot; “never create commits/comments on behalf of a user without explicit initiation.”
- **Write path:** GitHub App required for merge/comments; PAT connections are **read-only**.

**What this actually puts between agent and trunk**

1. Isolation: agent branch / session sandbox  
2. Forge PR as the shared object (CI, conversation, reviewers)  
3. Optional AI review (advise + optional check)  
4. Human eyes on improved diff UX  
5. Human click → **forge** merges under branch protection  

It does **not** put a Tachyon-style **tree-keyed local verify attestation** or a product that refuses to hand you a merge command when preconditions failed. It trusts the forge’s mergeability model (checks, approvals, conflicts).

---

## 4. Cursor (Cloud Agents + Bugbot)

**Verified / strong secondary:**

- Cloud Agents: isolated VM, branch, work, **optionally open PR**; human reviews/merges.  
- Bugbot: GitHub/GitLab PR comments; auto or `cursor review` / `bugbot run`; Autofix into new branch or existing (capped attempts).  
- PR cards can expose **Merge / auto-merge / ready** once a PR exists (forum staff).

**Between agent and trunk:** same forge-PR sandwich as Devin, with review split across Bugbot (and Graphite partnership for browser PR UX — **M**). Cursor marketing and third parties often say the product story **ends at the PR** (no deploy). Merge is not a local land gate.

---

## 5. GitHub Copilot cloud agent + code review

**Verified (docs.github.com):**

- Agent works on a branch, opens/iterates PRs, adds human as reviewer.  
- **No write to protected default branch** beyond PR flow (engineering narrative + design).  
- Merge conflicts: **Fix with Copilot** → resolve → recheck → **request human review**.  
- Actions on agent pushes: default **hold** until “Approve and run workflows.”  
- Code review: **Comment only** — never blocks, never counts as required approval.

**Between agent and trunk:** the forge itself is the ADE. The “governed door” is **branch protection + human merge**, with AI as non-blocking reviewer and optional conflict fixer.

---

## 6. Claude Code (local + Code Review + Actions)

**Verified (code.claude.com docs):**

- Local agent: working tree / branch; human owns git.  
- **Code Review (managed):** multi-agent PR analysis; severity; check run always **neutral** (non-blocking). Gating requires **your** CI parsing severity.  
- Local `/code-review` before push.  
- GitHub Action: `@claude` on issues/PRs can implement and open PRs; human merges.

**Between agent and trunk:** optional AI review layer on the forge PR; no product-owned land executor. Closest philosophical peer to Tachyon on “AI does not hold the merge button,” but without Tachyon’s measured local preconditions UI.

---

## 7. OpenAI Codex / OpenHands (shorter)

**Codex (V/M):** Cloud → draft/open PR; Code Review via `@codex review` / auto; human merges. Same PR sandwich.

**OpenHands (V):** PR review plugin (comments, priorities); Automation can APPROVE/REQUEST_CHANGES as a dedicated bot; culture of “@agent fix merge conflicts.” Critic model (blog 2026) scores runs **before push** — interesting **pre-PR** verifier, still not a land executor. **Not verified** live critic accuracy.

---

## 8. Does the PR screen remove dependence on the parent agent as reviewer?

This is the owner’s real question: *today the owner depends on the parent agent (claude) to know if a diff is good. Would a governed PR door remove that dependence?*

### What a PR-in-app screen **does** solve (logistics)

Without asking the parent agent, the human can see:

- CI check names and status  
- Conflict with trunk  
- Reviewers and human conversation  
- Draft vs ready  
- One place to click Merge under forge policy  

That **does** remove a class of dependence: “is it green / mergeable / who needs to look?” — questions the parent agent currently answers by inspection and report.

### What it **does not** solve (judgment)

Across every measured product:

- AI review is **advisory** (or only blocks if you *configure* forge policy to treat a bot/check as required).  
- None claim the AI replaces a human principal on “is this the right design for *this* repository’s standards.”  
- Copilot documents the strongest version of honesty: review is Comment-only and **cannot** satisfy required reviews.  
- Claude Code Review documents the same: neutral check; gate yourself if you want.  

So the PR screen **moves the same judgment** into a better UI (diff, conversation, CI) and may **filter noise** with agent findings. It does **not** automatically become a trustworthy substitute for “someone who knows this codebase decided the change is good.”

### What Tachyon’s parent-agent dependence actually is

It is a **role**, not a UI gap alone:

| Role the parent currently plays | Could a PR product own it? | Notes |
|--------------------------------|----------------------------|--------|
| Run verify gate / interpret failure | Partially | Tachyon already records tree-keyed verify; parent still *runs* and *reads* it |
| Inspect design / security / product fit | No (not honestly) | Same gap as every AI reviewer |
| Decide land vs more work | Human | Product can only surface evidence |
| Execute land safely | Human (deliberate) | Competitors execute via forge click; Tachyon refuses |

A PR screen would help the **owner** do the parent’s *logistics* job without waiting for a report. It would not, by itself, make the owner stop needing *someone* (human or agent) for **substantive** review — unless the team accepts advisory AI + CI as enough, which is a policy choice, not something the screen proves.

---

## 9. What Tachyon already does better / worse / what is worth copying

### 9.1 Already better (relative to the PR-ADE pattern)

1. **Fail-closed local preconditions with unmeasured ≠ false** — rare honesty. Forge “mergeable” collapses unknowns differently.  
2. **Tree-keyed verification** — content was green here; survives amend/rebase of message. Most PR UIs assert *checks on a tip*, not a Tachyon-style local gate record.  
3. **Command pins a SHA** — prevents “suggestion about tree A applied to branch tip B.”  
4. **Hard refusal to execute integrate** — authority and act are split; competitors re-join them at the Merge button (human still clicks, but the product *can* mutate trunk via API).  
5. **No mandatory PR** — works offline / private / no forge; matches this repo’s measured practice (local land after gate).

### 9.2 Missing relative to what those tools sell

1. **Human-facing delivery inbox** — list of ready/blocked deliveries with evidence, not only Control → Worktrees per row.  
2. **Diff + conversation + named remote CI** in one pane (when a remote exists).  
3. **Optional advisory agent review** as a first-party product path (today: parent agent ad hoc).  
4. **Conflict/CI fix loop** one click away (Copilot/Devin pattern: agent re-enters the same delivery).  
5. **One-click act** that is still human-gated — they give Merge; Tachyon gives a string. The open half of `t-7cb971` is whether the product should ever press Enter for the human under stronger proof.

### 9.3 What is worth copying (and what is not)

**Worth copying (substance, not chrome):**

| Idea | Why | Fit for Tachyon |
|------|-----|-----------------|
| **Delivery inbox with measured readiness** | Owner sees “ready / blocked / why” without asking parent | Extend land suggestion into a human-first list; keep fail-closed semantics |
| **Evidence panel, not vibes** | Named checks with green/red/detail (Devin merge bar; Tachyon land checks) | Already started; surface to owner, not only Control |
| **Advisory AI review as optional filter** | Catches some bugs before human time | Optional, never required approval; mirror Copilot honesty |
| **Conflict/CI re-entry** | Agent fixes, re-verifies, readiness updates | Fits worktree + re-probe land |
| **Human remains principal** | All serious products still require a human click for merge | Aligns with Tachyon; do not copy silent auto-land |

**Not worth copying as-is:**

| Idea | Why not |
|------|---------|
| **PR as mandatory delivery object** | This project lands locally; forge is optional (`pr.ts`). Forcing PR adds ceremony without proving quality. |
| **Merge button that hides local topology** | Primary-on-trunk / primary-clean / sha pin are *local* truths a forge merge does not replace for a multi-worktree host. |
| **“AI approved → safe to land”** | No measured product actually does this without lying or outsourcing to branch protection theatre. |
| **PR chrome alone** | Summary/Conversation/Code without stronger evidence only relocates the same judgment. |

**Direct answer to “does anything of value transfer?”**  
Yes — **the delivery inbox + explicit preconditions + human click**, not the PR metaphor. Devin’s screen is a polished instance of that pattern bound to GitHub. Tachyon already owns a stricter **evidence model** for local land; it lacks the **owner-visible, one-place, post-agent surface**. Copying a GitHub PR UI without binding it to verify + land checks would be a downgrade in honesty for this repo’s workflow.

If the answer had been “nothing worth copying,” it would be because the only value of those screens was social forge workflow. For Tachyon’s measured problem (broken hand merges on computable preconditions; owner dependence on parent for logistics **and** judgment), the logistics half is real product work; the judgment half is not solved by any ADE we measured.

---

## 10. Recommended reading order for the human discussion

1. This section 9 (verdict).  
2. Section 8 (dependence on parent).  
3. Devin Review deep dive (section 3) as the concrete competitor screen.  
4. Tachyon `land.ts` header comment + five checks (source of truth for “what we assert”).  
5. Decide later: product work is a **human delivery door** (t-7cb971 family), not “build PRs.”

---

## 11. Not verified (mandatory explicit list)

These were **not** confirmed in this research pass. Do not treat them as measured.

1. Live UI labels in Portuguese on any ADE (only the owner’s report).  
2. Cursor IDE/web: exact sidebar buckets matching “Need you / In progress / Drafts.”  
3. Whether Devin auto-resolves ordinary merge conflicts without a new agent session.  
4. Devin “self-review then PR” auto-fix loop quality claims (third-party blogs).  
5. Cursor Cloud Agent internal “30% merge rate” marketing numbers.  
6. Whether Cursor Merge button calls GitHub API identically to Devin’s documented path.  
7. Graphite + Cursor Agents deep integration behavior (announcement only).  
8. OpenHands critic model false-positive/negative rates.  
9. Whether OpenHands bot APPROVE is commonly used as a *required* GitHub reviewer in production orgs.  
10. Windsurf-as-Devin-Desktop UX parity after rebrand (secondary articles only).  
11. Factory, Amp, Replit Agent, Antigravity — not measured.  
12. Tachyon Control Worktrees UI pixel-level presentation of land checks (source + task text only; no browser visual QA this session).  
13. Live click of Merge on Devin/Cursor/Copilot accounts (docs only).  
14. Whether any product tree-keys CI the way Tachyon tree-keys verify records.  
15. Cost models (Devin ACU, Claude ~$15–25/review averages) as decision inputs — not re-audited.

---

## 12. Sources (primary first)

| Source | Use |
|--------|-----|
| This tree: `src/worktree/land.ts`, `pr.ts`, `review.ts`, ManagedWorktree land probe | Tachyon baseline |
| [Devin Review docs](https://docs.devin.ai/work-with-devin/devin-review) | In-app PR, merge, auto-review, checks |
| [GitHub Copilot cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github) | PR, conflicts, workflow approval |
| [GitHub Copilot code review](https://docs.github.com/copilot/using-github-copilot/code-review/using-copilot-code-review) | Non-blocking reviews |
| [Claude Code Review](https://code.claude.com/docs/en/code-review) | Neutral check, advisory findings |
| [OpenHands automated code review](https://docs.openhands.dev/openhands/usage/use-cases/code-review) | GHA review + bot verdict events |
| Cursor forum (staff) on Create PRs / auto-merge | Cloud Agents PR settings |
| Cursor Bugbot product pages + third-party writeups | Advisory PR review (mixed V/M) |
| Codex GitHub code review docs | `@codex review` pattern |

---

## 13. One-paragraph bottom line

Other ADEs put a **forge pull request** between agent and trunk: the agent ships a branch/PR, optional AI review **advises**, CI and branch protection **constrain**, and the human’s one click is almost always **Merge via the forge API**. Tachyon puts a **measured local land suggestion** between agent and trunk and **refuses to execute** it. The PR screen the owner saw is a strong human UX for forge logistics; it does **not** honestly replace substantive review of whether a diff is good. What is worth taking is a **delivery inbox of measured readiness for a human principal** — not mandatory PRs, not AI-as-required-approver, and not a Merge button that forgets primary-checkout topology and tree-keyed verify.
