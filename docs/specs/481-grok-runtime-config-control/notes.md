# 481 — grok-runtime-config-control — notes

## Measurement log — grok 0.2.112, 2026-07-28

Binary: `~/.grok/downloads/grok-0.2.112-linux-x86_64`. All probes ran against a disposable
`GROK_HOME` and a synthetic git repository; the person's real `~/.grok` was never written.

### Sources and layering

`grok inspect --json` reports `configSources.layers`. With a global config, a repo-root
`.grok/config.toml` and a `<cwd>/.grok/config.toml`, all three load — one `user` layer and two
`project` layers, matching the guide the release ships at `$GROK_HOME/README.md`
(§ Project-Scoped MCP Servers), which also states that **only `[mcp_servers]`** is honored in project
scope. That single sentence is why the workspace document has no scalar editor.

### What is proven, and what is only documented

| Claim | How it was established |
|---|---|
| `enabled = false` disables an MCP server | Behavioral: the server disappears from `grok inspect --json` |
| Project hooks need folder trust | Behavioral: `hooks: []` untrusted, one hook after the trust entry |
| Project hooks also need a git `projectRoot` | Behavioral: the dogfood failed until the temp repo was `git init`-ed |
| Project MCP does not need a project root | Behavioral: it loaded from a non-git directory |
| The measured config keys exist | The installed binary's strings, plus the version-matched README |
| Key TYPES | The README's documented examples — `grok inspect` validates nothing, so no stricter proof exists |

The last row is the honest limit of this slice: Grok's config loader accepts a wrong type and an
unknown key without complaint, so there is no equivalent of the Codex "expected one of" oracle. The
adapter compensates by refusing anything outside the measured type and range **before** writing,
which is a Tachyon-side bound rather than a runtime-side one.

### Two measured quirks worth not repeating

- **`grok inspect` misattributes provenance.** A server declared only in `<cwd>/.grok/config.toml` is
  reported with `source.path` pointing at the GLOBAL config. The adapter therefore reads the files
  directly and never uses `inspect` to decide which document owns a server.
- **`inspect` is not a validator.** `[models] default = 123` and `[models] bogus_key = 1` both pass
  silently, so a green `inspect` proves discovery, not correctness.

### The correction: `t-26f508` superseded this slice's impact rule mid-flight

Everything below was measured before `t-26f508` landed on `main`, and it was true then: every Grok
agent launched with a Bridge-only private `config.toml`, so the **global** document reached none of
them. `t-26f508` then gave canonical Grok profiles a projection over `~/.grok/config.toml`
(`selectors`/`permissions`/`interface`/`featureFlags`, `global` as the only source), which makes the
global document reach a canonical agent exactly as Claude's and Codex's do.

That change was discovered while merging `main` before landing, and the slice was corrected rather
than shipped with a stale claim:

- the global document's `impact` sentence now says the reach depends on the agent;
- `markRuntimeConfigPending` no longer special-cases Grok's global scope — it falls through to the
  same projection rule Claude and Codex use, and keeps the Grok-specific branch only for the
  workspace scope, which is not a projection and cannot be one;
- both directions are pinned: a canonical Grok profile IS marked for the global source, a
  profile-less agent is NOT (and is still marked for workspace).

Worth noting that `t-26f508` independently re-measured the workspace half and agrees with this
slice: an ambient project `[mcp_servers.ambient]` DID reach the effective server list under a private
`GROK_HOME`, and project `[ui]`/`[permission]` keys were ignored. Two lanes measuring the same
runtime a day apart and landing on the same layering is the strongest form this evidence takes.

### Impact — the finding that shaped the design (as first measured, now superseded above)

`HarnessManager.materializeBridgeMcpGrok` writes `$privateHome/config.toml` from scratch on every
spawn (Bridge MCP block only) and never reads `~/.grok/config.toml`. So the global document cannot
affect a Tachyon-managed Grok agent, and marking one pending would be a promise the runtime does not
keep. The workspace document is discovered from the working directory, which is inside the
workspace, so it does apply at the next launch. `Workspace.markRuntimeConfigPending` gained a
Grok-specific branch for exactly this, and each document carries an `impact` sentence so the UI
states the difference rather than leaving it to be inferred.

## The Dev Host is not an agent's tool (2026-07-28)

Mid-slice, the human rule was made explicit: **agents do not open VS Code or an Extension
Development Host.** A Dev Host scenario had been written and partially exercised before that; it was
removed rather than left behind, so nothing in this slice invites an agent to launch an EDH, and no
visual verdict is claimed from one.

The UI half moved to `test/browser/grokRuntimeConfigView.test.ts`, which drives the same shipped
`cockpit` bundle and stylesheets in headless Chrome through the webview preview server. That covers
rendering, state and layout; it does **not** cover the extension host behind the webview, which is
why the save path stays proven host-side (unit suite) and against the real binary (round-trip
dogfood) rather than through the UI.

One measurement survives from the removed scenario and is worth keeping: the runtime dropdown is the
Kit (Radix) dropdown and opens on `pointerdown` **alone** — a trailing `click()` toggles it straight
back shut, which is why the browser test dispatches `pointerdown` and nothing else. The same applies
to any future test that drives this control.

## Review findings (claude-reviewer, 2026-07-28)

Two audits passed on probes rather than reading — raw-text CAS (the runtime rewriting its own config,
an omitted `expectedRevision`, and a creation race all surface as conflicts with the file preserved)
and secret opacity (six secrets planted at different depths and shapes, none serialized).

The audit also found a defect the slice's own tests missed, and it was a good one: **the lock excluded
nothing.** Both adapters released it in a `finally` that unlinked unconditionally, so the caller that
LOST the race deleted the winner's lock on its way out — proven, not argued. The obvious repair is a
trap of its own: guarding the unlink turns a crashed save into a lock nobody can clear from the UI,
because that unconditional unlink was accidentally the only thing recovering an orphan.

Fixed as one shared `src/runtimeConfig/sourceLock.ts` used by BOTH adapters, since the duplication is
what propagated the bug (Claude had it too, shipped in SDD 464; Codex never had a lock). Release is
owner-only, the lock file carries its holder's pid, an orphan whose holder is gone is stolen once, a
live holder keeps it, and the refusal names the file to delete. Same shape as `acquireVerifyFullLock`
(t-6a9bc4), which had to solve this here already. `test/unit/runtimeConfigSourceLock.test.ts` pins it,
and three of its cases were confirmed to FAIL against the old release path before the fix landed.

Their non-blocking note is also taken: `models.api_key` at depth 2 was classified non-opaque, so the
NAME appeared in `unknownKeys` (a name, never a value). Opacity under `models` is now keyed on the
owned-key allowlist rather than depth, which is the rule that cannot drift.

A second review pass on the fix returned CLEAN and proved two residuals, both closed rather than
filed, because one of them was a comment that overstated its own guarantee — the same class of defect
the fix existed to remove:

- **R1, release was scoped by path.** The `finally` unlinked whatever sat at the path, so a lock taken
  from us mid-body would be deleted on our way out — the original defect one level down. Release now
  re-reads the pid and leaves a foreign lock alone.
- **R2, "create and stamp in ONE call" was false.** `writeFileSync(..., {flag:"wx"})` is open + write,
  so a lock can be seen unstamped, and reading that as "crashed" let a live holder be robbed
  mid-create. `wx` still provides the exclusion (that part IS atomic); the unstamped window is now
  decided by age — fresh means someone is mid-create, stale means the create died.

A third pass then asked for the stronger property rather than the tolerance: publication must never
expose an empty lock AND never overwrite a holder. `open(wx)`+`write` gives the second but not the
first; `rename` gives the first but not the second (it replaces a live holder). `link` is the only
primitive with both — it fails with `EEXIST` on an existing target and what appears at the path is
the fully-written source — so the pid is written to a private temp and linked into place. The age
rule stays as the guard for the `open(wx)` fallback (filesystems without hard links) and for a lock
this module did not write. The fallback is exercised by a test rather than left as dead code.

They also corrected a claim of mine in the other direction: I reported 3 tests failing against the
pre-fix release path; restoring fuller pre-fix semantics fails 7 of 8. The claim was conservative, not
inflated, and the correction is theirs. The two residual tests above were likewise confirmed to fail
against the previous commit before being fixed.

## Dogfood log

`npm run dogfood:grok-runtime-config` — 2026-07-28, grok 0.2.112 (9bbd559437): **15/15**.
Covers inventory-vs-runtime agreement, payload absence, the workspace scalar refusal, the native MCP
toggle round-trip in both directions, comment/unknown-table/credential survival, stale-revision
refusal with the concurrent edit preserved, and folder trust reported-but-never-granted (including
the hook that stays unloaded while untrusted and loads once trusted).
