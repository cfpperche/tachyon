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

### Impact — the finding that shaped the design

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

## Dogfood log

`npm run dogfood:grok-runtime-config` — 2026-07-28, grok 0.2.112 (9bbd559437): **15/15**.
Covers inventory-vs-runtime agreement, payload absence, the workspace scalar refusal, the native MCP
toggle round-trip in both directions, comment/unknown-table/credential survival, stale-revision
refusal with the concurrent edit preserved, and folder trust reported-but-never-granted (including
the hook that stays unloaded while untrusted and loads once trusted).
