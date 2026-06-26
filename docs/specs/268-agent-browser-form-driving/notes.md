# 268 — notes

## The key discovery that shapes v2

`agent-browser` ships a **native action-safety surface**, so v2 does not hand-roll a wrapper gate:
- `--confirm-actions <categories>` / `AGENT_BROWSER_CONFIRM_ACTIONS` — hold a write in `confirmation_required`.
- `confirm <id>` / `deny <id>` — resolve a pending action; **auto-deny after 60 s**, and **auto-deny when stdin
  is not a TTY** (verified from `confirm --help`). A Tachyon agent is non-TTY → a gated write is fail-closed.
- `--allowed-domains` / `AGENT_BROWSER_ALLOWED_DOMAINS` — restrict navigation (makes "prefer staging" enforceable).
- `--action-policy <json>` — static allow/deny/confirm file.
- Example from upstream: `--confirm-actions eval,download`; categories referenced include navigation, interaction,
  eval, download (exact strings TBD from the binary — OQ2).

This turns v1's prose "ask before writing" into a **mechanical** gate: a headless write is auto-denied unless a
human confirms by id.

## Why env-mandated, and the honest limit (OQ1)

There is no Tachyon mechanism today for a plugin to force default env/args onto a provisioned tool — the launcher
execs the binary with the agent's argv. So v2's gate is "on" only when the skill-mandated session env
(`AGENT_BROWSER_CONFIRM_ACTIONS` + `_CONFIRM_INTERACTIVE`) is exported. That is a real fail-closed improvement
(writes are actually held + auto-denied), but an agent could call the launcher without the env. Bypass-proof
enforcement wants a launcher that injects a tool's declared default env/args — a spec-265-family ENGINE change,
filed as OQ1, not built here. Flag it; don't ship a soft gate as if it were hard.

## Carry-overs from v1 (spec 267)

- Same provisioned binary + launcher (no engine change in v2 itself); same `.tachyon/` gitignored credential-class
  home (now also the action log); same dogfood → codex-dueto → tag rhythm; spec-266 update detection already
  governs the plugin (a `v0.8.0` carrying 2.0.0 will surface as an update from the installed 1.0.0).

## Sources

- `agent-browser` CLI `--help` / `confirm --help` (run via the launcher): the `--confirm-actions`,
  `--action-policy`, `--allowed-domains`, `--confirm-interactive` flags + the confirm/deny/60s/non-TTY semantics.
- DeepWiki vercel-labs/agent-browser (Security / Advanced features) + README.

## Build + dogfood (2026-06-26)

Built on the shipped spec-269 `launchPolicy`. agent-browser plugin → **2.0.0**: the manifest declares
`tools.agent-browser.launchPolicy { env: { AGENT_BROWSER_CONFIRM_ACTIONS: "click,dblclick,fill,type,press,key,
select,check,uncheck,upload,drag,eval,download" }, denyArgs: ["--confirm-actions","--action-policy"], mode:
"force" }`. SKILL.md gained a form-driving section (the held-write contract + surface-the-id + allow-list +
action-log); README + frontmatter updated.

**OQ2 resolved (drove the binary):** `--confirm-actions` categories are the ACTION NAMES (a `click` under
`--confirm-actions click` returns `confirmation_required`; an unknown category is silently ignored). The
write-category list above covers the mutating commands; reads (navigate/snapshot/screenshot/get) are not listed →
free.

**Live dogfood into /home/goat/tachyon (installed 2.0.0, lockfile carries the policy), proven END-TO-END:**
- My shell `AGENT_BROWSER_CONFIRM_ACTIONS` was **UNSET**, yet a WRITE (`click @e2`) returned
  `confirmation_required` + id — **the launcher force-set the env** (the launchPolicy works; the agent sets nothing).
- A READ (`get title`) ran free.
- The agent trying to disable the gate with `--confirm-actions ""` → **`POLICY_CONFLICT`, refused** (can't ungate
  via argv).

## Live dogfood bug — navigation was wrongly gated (fixed)

First live UI dogfood (maintainer, 2026-06-26): the agent's `open https://example.com` (Step 3, a READ) returned
`confirmation_required` — navigation was being held. Cause: folding codex BLOCK #1 (expand the category list) I
**over-reached** and added navigation/movement actions (`open,goto,navigate,back,forward,reload,scroll,hover,
mouse,…`) to `AGENT_BROWSER_CONFIRM_ACTIONS`, which broke the read-first contract (the agent couldn't even open a
page without approval). Fix: tighten the list to the **page-WRITE** actions only —
`click,dblclick,fill,type,press,key,keydown,keyup,keyboard,select,check,uncheck,upload,drag,eval,download` —
gating the form-driving threat while leaving navigation/snapshot/screenshot/scroll FREE. Re-verified live: `open`
runs free (`success=true`), `click` is held. The broader session-mutators (storage/cookies/auth/network) stay in
the documented best-effort gap rather than over-gating navigation to cover them.

## Separate finding (NOT agent-browser) — secrets-guard hook error surfaced

The same dogfood surfaced a pre-existing **secrets-guard** issue: its `PreToolUse(Bash)` hook errors with
`/bin/sh: 1: /guard.sh: not found` — `${PLUGIN_ROOT}` resolves to EMPTY in the live Claude runtime, so the
layer-2 shape-gate's `"${PLUGIN_ROOT}"/guard.sh` becomes `/guard.sh`. Non-blocking (the agent continues), but it
means secrets-guard's layer 2 isn't actually firing in a Tachyon-spawned agent. A separate bug in the
secrets-guard/Tachyon hook `${PLUGIN_ROOT}` substitution — flagged for its own investigation.

## Decisions & deviations (build-time)

- **OQ3:** env categories (not a bundled `--action-policy`) — simplest, and the policy forces it on every run.
- **OQ1/honesty (the self-confirm residual):** the gate HOLDS a write (`confirmation_required`, not silent) and
  surfaces the id for a human `confirm <id>`. A same-user shell agent could self-`confirm` — the SAME residual as
  spec 269 (the launcher enforces the *held* gate, not a sandbox). The skill's contract ("surface + STOP; do NOT
  self-confirm") makes the human the approver; true enforcement = agent sandboxing (future research). Documented,
  not advertised away.
- **Confirm-interactive deliberately NOT forced:** with `--confirm-interactive` + non-TTY the write would
  auto-DENY, killing autonomous form-driving entirely; the held+surface model keeps the capability while making
  writes non-silent.
- **`AGENT_BROWSER_ALLOWED_DOMAINS`** is per-task skill guidance (a staging allow-list), not a fixed policy.

## Codex dueto (2026-06-26) — BLOCK; partially folded, decision pending (NOT tagged)

Codex found the launchPolicy can't fully lock down agent-browser — too many gate-override surfaces. 3 BLOCK + 3
SHOULD + 1 NIT. Folded the cheap+correct parts:
- **mcp/batch/--config denied** (BLOCK #3 + part of #2): `agent-browser mcp` exposes `extraArgs` (CLI parity) and
  `batch` reparses command strings — their inner args escape the launcher's denyArgs; `--config` loads a
  caller-controlled config that can weaken the action-policy. All three now refused (live-verified POLICY_CONFLICT).
- **Expanded the forced category list** toward the mutator surface (BLOCK #1, partial).
- **Honest docs** (#4/#6/#7): "common mutating actions, best-effort"; "mechanical hold + cooperative approval, not
  airtight"; README → `--help`.

**Irreducible with the current launchPolicy (the decision):**
- **#2 env/config-file override NOT closed.** `AGENT_BROWSER_ACTION_POLICY` / `AGENT_BROWSER_CONFIG` (env) and
  on-disk config files (`./agent-browser.json`, `~/.agent-browser/config.json`) can still weaken the gate. The
  launchPolicy can only **set** env, not **unset/scrub** it — and setting `""` BREAKS the binary (treated as an
  empty config path: "config file not found"). Closing this needs a launcher **`denyEnv`/unsetEnv** capability
  (a spec-269 enhancement) + still can't block on-disk config files.
- **#1 category completeness NOT guaranteed.** Unknown categories are silently ignored, so a missing/renamed
  mutator runs ungated. A hand-list (even expanded) can't prove completeness; the real fix is a **doctor that
  probes the pinned binary** (each known mutator must return `confirmation_required`) + re-proves on a spec-266
  bump.
- **self-confirm residual** (same-user agent), as spec 269.

→ Status: **draft/in-progress, NOT tagged.** Pending a maintainer decision: (a) invest in a launcher `denyEnv` +
a category-probe doctor for a tighter (still-not-airtight) gate; (b) ship best-effort + honestly-scoped; (c)
rethink the form-driving safety model (skill-contract + human-in-Activity) given the tool's override surface.
