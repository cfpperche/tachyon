# ACP across our six runtimes, and what the community already ships

_Task `t-2aabc0`, 2026-08-12. Every number in sections 1–3 was produced by running a command on this
host today. Section 4 and the parts explicitly marked **READ** are documentation or source reading,
and they are never mixed into a measured paragraph._

---

## The verdict, first

**All six of our runtimes answer a real ACP `initialize` on this host.** Three natively, three through
an adapter. That is a stronger result than the task assumed, and it was measured, not read.

**The community has already built our exact surface.** `formulahendry/vscode-acp` is a complete VS Code
webview ACP chat — permissions, terminals, file access, session history — in **6,041 lines**, MIT,
running under the *strictest* webview CSP (`default-src 'none'; script-src 'nonce-…'`). For comparison,
Orca's protocol-less chat façade is **19,160 lines** and covers 5 of 38 CLIs
(`docs/research/t-5f4294-orca-chat-ui.md`).

**ACP covers the two things we were most afraid of losing.** Tool-permission requests and session
resume are both first-class protocol methods, and I measured a session load replaying its real
conversation as structured events with no decoder of ours involved.

**But the cost is not where the task expected it.** It is not "does ACP have the events" — it mostly
does. The cost is that **an ACP session is a child process our client owns; it is not the tmux pane the
product manages.** Every pane-shaped mechanism we have — `capturePane`, `write_input`, AttentionMonitor,
the composer-region reader — addresses a pane, and an ACP agent has none. Layer 3 is not a new front-end
over our existing agents. It is **a second kind of agent**, and the bill is paid in the Bridge, not in
the chat view.

**Recommendation (defended in §5): both, in order — ACP chat first, `t-e63164` descoped but not
cancelled.** Details, and what would change my mind, in §5.

---

## How to reproduce this

Nothing was installed into or cloned into the product repository. Third-party trees and probe scripts
live in this session's scratchpad, outside `/home/goat/tachyon`:

```
/tmp/claude-1000/-home-goat--cache-tachyon-worktrees-b349073a-acpscan/
  6dc5b380-8938-422a-8061-c8d2691d9bc7/scratchpad/
    acp-probe.mjs         initialize handshake, prints whatever comes back
    acp-session-list.mjs  initialize -> session/list
    acp-load.mjs          initialize -> session/load, counts replayed session/update
    pkgs/                 npm tarballs, extracted for reading
    vscode-acp/           git clone, commit e7371659e3ac100db842b419b1361205a193032e
```

The probe is deliberately dumb: it writes one ACP `initialize` request to the child's stdin and prints
stdout verbatim. A runtime that answers with a `protocolVersion` is speaking ACP; one that answers
anything else is not, and the difference is visible in the raw bytes rather than in my summary of them.

Third-party clone: `git clone https://github.com/formulahendry/vscode-acp`, commit
`e7371659e3ac100db842b419b1361205a193032e`, authored 2026-05-16T17:29:40+08:00. No code from it was
copied here; the citations below are paths, line counts and short quotes.

The schema cited throughout is `@agentclientprotocol/sdk@1.3.0`, file `schema/schema.json` — 262
definitions, published 2026-07-21.

---

## 1. Coverage: the six runtimes

Installed versions, read from the binaries on this host today:

```
claude 2.1.228 (Claude Code)   codex-cli 0.146.1      grok 1.0.3 (1a29d5bc12) [stable]
opencode 1.18.16               Hermes Agent v0.18.2   pi 0.80.10
```

| runtime | speaks ACP? | native or adapter | official or community | command | version measured | measured/read |
|---|---|---|---|---|---|---|
| **grok** | **yes** | native | first-party (xAI) | `grok agent stdio` | grok 1.0.3 | **MEASURED** |
| **opencode** | **yes** | native | first-party | `opencode acp` | opencode 1.18.16 | **MEASURED** |
| **hermes** | **yes** | native | first-party | `hermes acp` | hermes 0.18.2 | **MEASURED** |
| **claude** | yes, via adapter | adapter (separate process) | **official ACP org** | `npx @agentclientprotocol/claude-agent-acp` | claude 2.1.228 · adapter 0.66.0 | **MEASURED** |
| **codex** | yes, via adapter | adapter (native binary) | **official ACP org** | `npx @agentclientprotocol/codex-acp` | codex 0.146.1 · adapter 1.2.0 | **MEASURED** |
| **pi** | yes, via adapter | adapter | **community, one maintainer** | `npx pi-acp` | pi 0.80.10 · adapter 0.0.33 | **MEASURED** |

### What each one actually returned

All six returned `"protocolVersion":1`. The capability sets differ, and the differences matter:

| runtime | loadSession | resume | fork | list | close | delete | image | embeddedContext |
|---|---|---|---|---|---|---|---|---|
| grok | ✅ | ✅ | — | ✅ | ✅ | — | ❌ `false` | ✅ |
| opencode | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| hermes | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | — |
| claude (adapter 0.66.0) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| codex (adapter 1.2.0) | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| **pi (adapter 0.0.33)** | ✅ | **❌** | **❌** | ✅ | — | ✅ | ✅ | ❌ |

**`pi` is the weak leg and the table says so precisely:** its adapter advertises `loadSession` but
neither `resume` nor `fork`. It is `pi-acp@0.0.33`, MIT, published by a single maintainer
(`svkozak`), last modified 2026-07-30. Treating it as equivalent to the other five would be wrong.

### What is *not* ACP, also measured

Two negative results worth recording, because both are easy to mistake for coverage:

- **`codex app-server` is not ACP.** Sent the same `initialize`, got
  `{"error":{"code":-32600,"message":"Invalid request: missing field 'clientInfo'"},"id":1}` — note it
  does not even carry a `jsonrpc` field. It is Codex's own protocol, which is consistent with its
  subcommands `generate-ts` and `generate-json-schema` describing "the app server protocol". Codex's
  ACP door is the adapter, not this.
- **`pi --mode rpc` is not ACP.** Answered
  `{"id":1,"type":"response","success":false,"error":"Unknown command: undefined"}` — its own
  request/response envelope, not JSON-RPC 2.0.
- **The `claude` CLI has no ACP.** `claude --help` matches nothing for `acp`, `agent-client` or
  `protocol`, and no subcommand exposes one. Its ACP door is the adapter.

### One finding that outruns the question

`grok agent stdio` returns, inside its `initialize` result, a machine-readable
**`availableCommands`** list — `compact`, `context`, `session-info`, `deep-research`, `workflow`,
`goal`, `always-approve` — each with a description and an input hint. ACP has a `available_commands_update`
notification for exactly this.

That matters because Orca hand-maintains a curated slash-command list and says why
(`native-chat-slash-commands.ts:16-18`, quoted in `t-5f4294`): *"the CLIs ship no machine-readable
command list"*. Over the PTY that is true. **Over ACP it is false.** This is a concrete capability the
protocol has and the façade cannot get.

### Governance signal (part measured, part READ)

**Measured:** installing `@zed-industries/claude-code-acp` emits
`npm warn deprecated … This package has been renamed to @agentclientprotocol/claude-agent-acp`. The
deprecated 0.16.2 still completed a full handshake.

**Measured (registry metadata):** the adapters have moved out of Zed's namespace into a vendor-neutral
`@agentclientprotocol` org, and they are actively maintained — `codex-acp@1.2.0` was modified
**2026-08-12T13:02Z, i.e. today**; `claude-agent-acp@0.66.0` on 2026-08-07; `sdk@1.3.0` on 2026-07-21.

The version jump is worth noting as a risk, not a reassurance: Claude's adapter went `0.16.2 → 0.66.0`
in under five months. Adapters track fast-moving CLIs, and that churn is a maintenance surface we would
be adopting, not avoiding.

---

## 2. What the community ships, and whether it survives a VS Code webview CSP

Our constraint: no external host, no CDN script, no remote font, no outbound fetch from the webview.

### 2a. `acp-ui` on npm is a different protocol entirely

**Measured.** `npm view acp-ui` → version `0.0.1-alpha.1`, MIT, last modified **2025-10-01**, described
as *"A UI package implementing the **Agentic Commerce Protocol** (ACP) standard"*. Unpacked size **334
bytes**. Extracting the tarball yields exactly one file — `package.json`. There is no `index.js`, no
code at all.

The npm name is a collision with an unrelated protocol and holds an empty placeholder. **READ:** the
ACP UI that people mean is `formulahendry/acp-ui` on GitHub, a cross-platform desktop/mobile/web client
— a separate project from the npm package, and not a library we could depend on.

Verdict: **unusable, and not for CSP reasons — there is nothing there.**

### 2b. `use-acp` — CSP-clean bundle, but the transport is welded on

**Measured**, on the published bundle (`use-acp@0.2.6`, Apache-2.0, marimo-team, last modified
2026-01-12 — seven months stale as of today).

Scanning `dist/**/*.js` for the constructs a webview CSP forbids:

| construct | occurrences |
|---|---|
| `new Function` | **0** |
| `eval(` | **0** |
| `fetch(` | **0** |
| `https://` / `http://` | **0** / **0** |
| `cdn` | **0** |
| `importScripts`, `new Worker` | **0** |
| `document.write`, `innerHTML` | **0** |
| `WebSocket` | 19 |

So the bundle itself is CSP-compatible: it needs no `unsafe-eval`, embeds no external host, and pulls
no remote font. That is the good half, and it is the half a README would not have told us.

The bad half is the API shape. Its only transport is `new WebSocket(this.options.url)`
(`dist/connection/websocket-manager.js:80`), and the public hook requires it:

```ts
export interface UseAcpClientOptions {
    wsUrl: string;          // mandatory — no transport injection point
    ...
}
```

There is no way to hand it a `postMessage` channel. Using it in our webview would mean running a
WebSocket server in the extension host and widening the webview's `connect-src` to a local `ws://`
origin — a real change to our CSP posture, for a library last touched seven months ago.

Verdict: **works under CSP, but only by adding a WebSocket hop we do not otherwise need.** Not
recommended as a dependency; its `useAcpClient` return shape (`pendingPermission`, `resolvePermission`,
`availableCommands`, `sessionMode`, `agentCapabilities`) is nonetheless a good map of what an ACP client
must expose, and worth reading before we design ours.

### 2c. `formulahendry/vscode-acp` — the decisive artifact

**Measured**, by reading the clone at commit `e7371659e3ac…`. MIT. This is a shipping VS Code extension
whose chat is a **webview**, i.e. exactly our surface and exactly our constraint.

Its webview CSP, verbatim from `src/ui/ChatWebviewProvider.ts:374`:

```
default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';
```

That is the strictest useful policy — `default-src 'none'` forbids everything not re-granted, scripts
are nonce-pinned, and no external origin appears anywhere. **An ACP chat demonstrably runs under a CSP
at least as strict as ours.** The question the task called decisive for §2 is therefore settled
affirmatively, by reading a bundle that ships.

Size, and how it splits:

| part | lines | what it is |
|---|---|---|
| `ui/ChatWebviewProvider.ts` | 2,559 | the chat UI itself |
| `handlers/TerminalHandler.ts` | 241 | `terminal/*` — hosting terminals *for* the agent |
| `core/AcpClientImpl.ts` | 113 | the client object the SDK calls back into |
| `handlers/FileSystemHandler.ts` | 80 | `fs/read_text_file`, `fs/write_text_file` |
| `handlers/PermissionHandler.ts` | 74 | `session/request_permission` |
| `handlers/SessionUpdateHandler.ts` | 38 | `session/update` fan-out |
| **whole `src/`** | **6,041** | everything, including tests and telemetry |

**The protocol obligations total 546 lines.** That is the entire cost of *being* an ACP client — the
rest is UI, which we would write in our own design system regardless. Its production dependencies are
three: `@agentclientprotocol/sdk`, `marked`, and VS Code telemetry.

One nuance worth stating so it is not mistaken for a CSP violation: the extension does fetch
`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
(`src/config/RegistryClient.ts:15`) — an agent registry. That call is made **from the extension host in
Node, not from the webview**, so it never meets the webview CSP. It also illustrates the architecture
the constraint forces on everyone: network and process-spawning live in the extension host, and the
webview only renders. That is already how our pane is built.

**READ, not measured:** at least two further VS Code ACP clients exist (`omercnet/vscode-acp`,
`IrishBruse/vscode-acp-ui`), and Zed publishes a VS Code client page. I did not clone or run them.
"Casper", named in the task, is **READ**: search results describe it as a web client for `kiro-cli`
over ACP — a browser client for a CLI we do not ship, so it is not a component we would reuse.

### 2d. Other packages on the registry (metadata measured, code not read)

`npm search` surfaced a live ecosystem; I checked publish metadata only, and did not run these:

| package | version | license | last modified | note |
|---|---|---|---|---|
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 | 2026-07-21 | the official TS SDK |
| `@qlairoslabs/acp-client` | 0.3.4 | MIT | 2026-08-04 | *"embeddable … with degraded PTY fallback"* — same hybrid we are debating |
| `@tanstack/ai-acp` | 0.2.5 | MIT | 2026-08-10 | ACP transport + AG-UI translation |
| `@acp-kit/core` | 0.10.2 | MIT | 2026-06-08 | client framework over the SDK |
| `acp-factory` | 0.1.15 | MIT | 2026-06-02 | spawning/managing ACP agents |
| `acpx` | 0.13.0 | MIT | 2026-07-27 | headless CLI ACP client |

---

## 3. What ACP does *not* cover — the question that decides the cost

The protocol surface, extracted from `schema.json` — 38 methods:

```
session/new  session/prompt  session/update  session/cancel  session/load  session/resume
session/list  session/fork  session/close  session/delete  session/request_permission
session/set_mode  session/set_config_option        authenticate
fs/read_text_file  fs/write_text_file
terminal/create  terminal/output  terminal/wait_for_exit  terminal/kill  terminal/release
document/didOpen  didChange  didFocus  didSave  didClose
elicitation/create  elicitation/complete      mcp/connect  mcp/disconnect  mcp/message
providers/list  providers/set  providers/disable        nes/start  nes/suggest  nes/accept  nes/reject  nes/close
```

The 13 `session/update` variants:

```
user_message_chunk  agent_message_chunk  agent_thought_chunk
tool_call  tool_call_update  plan  plan_update  plan_removed
available_commands_update  current_mode_update  config_option_update
session_info_update  usage_update
```

### 3a. The five dependencies the task named

| what we depend on today | ACP equivalent | verdict |
|---|---|---|
| **Tool permission request** | `session/request_permission`, with typed options; `ToolCallStatus.pending` documented as *"awaiting approval"* | **COVERED, and better.** Today Orca answers these by sending `'1'` for Allow and `ESC` for Deny because pasting the label commits the wrong option (their STA-1860). ACP returns a structured option id. |
| **Session resume** | `session/load`, `session/resume`, `session/list`, `session/fork` | **COVERED for 5 of 6.** Measured working (see 3b). `pi-acp` advertises neither `resume` nor `fork` — that one is a real gap. |
| **AttentionMonitor's signal** | partly; see 3c | **MOSTLY COVERED, and more exact — one state lost.** |
| **Composer region for `write_input`** | none, by construction | **NO EQUIVALENT — but see 3d, this is mostly a dissolution, not a loss.** |
| **Transcript → 23 Activity event types** | 13 `session/update` variants | **19 of 23 map; 4 do not.** See 3e. |

### 3b. Resume and transcript, measured rather than argued

Two probes, because this is the claim most worth doubting.

**`session/list` sees what the TUI wrote.** Running it against `grok agent stdio` returned sessions
belonging to *other, live Tachyon agents* — including `cwd`
`/home/goat/.cache/tachyon/worktrees/b349073a/composerrule` on branch
`tachyon/tmp.composerrule.20260812-134642-9411`, `updatedAt` 13:48 today, minutes before the probe. The
same call against `opencode acp` enumerated sessions going back to 2026-07-07.

So ACP is not sealed off from the sessions our tmux-hosted agents produce: **it reads the same store the
TUI writes.**

**`session/load` replays real history as structured events.** Pointed at a *dead* opencode session from
2026-07-27 (`ses_05e89db97ffewf5YfHvTP5Ur8J`) — deliberately not a live sibling's session, since loading
one could disturb an agent that is working — the agent replayed the conversation as `session/update`
notifications:

```
session/update notifications replayed during load: 2
by variant: { "user_message_chunk": 1, "agent_message_chunk": 1 }
first: {"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Reply with exactly: ok"}}
then:  {"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}
```

and the `session/load` response additionally carried the full model catalog as `configOptions`.

**This is the single most expensive thing we own, delivered by the protocol.** We maintain six
normalizers — `claudeNormalizer`, `codexNormalizer`, `opencodeNormalizer`, `grokNormalizer`,
`hermesNormalizer`, `piNormalizer` — plus a tail-reader stack, to turn on-disk transcripts into events.
Orca maintains four decoders (84–247 lines each) plus a session-file resolver, because every CLI hides
its transcript somewhere different. Over ACP none of that exists: the agent hands you typed events, and
the model list arrives with them.

Caveat, stated because I did not measure it: this proves ACP can **load and replay** a session the TUI
wrote. It does **not** prove two clients can drive one *live* session concurrently. `grok agent --help`
advertises a `leader` mode — *"Run as the shared leader process for other clients. Allows multiple
clients to share one backend"* — which suggests grok supports exactly that, but I read that help text
and did not test it. Nobody should plan on live co-driving until it is measured.

### 3c. Attention: more exact, except for one state

Our `AttentionState` is `working | idle | needs-input | throttled` (`src/attention/AttentionMonitor.ts:10`),
with latches for stalled, awaiting-human, auth-required and done-unseen. It is derived from tmux
`capturePane` output plus `#{window_activity}` — 979 lines of inference from pixels.

| our signal | ACP | verdict |
|---|---|---|
| `working` / `idle` | `session/prompt` is a **request**: outstanding = working, returned = idle, with a typed `StopReason` (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) | **Exact, not inferred.** Today we guess a turn ended from the screen going quiet; ACP tells us, and tells us *why*. |
| `needs-input` | `session/request_permission` arrives as a request we must answer | **Exact.** |
| auth-required latch | `authenticate` + typed `AuthMethod` (`AuthMethodTerminal`, `AuthMethodEnvVar`, …) | **Covered, richer.** Measured: hermes and pi both declare a *terminal* login method with args, so the client can offer the right remedy. |
| stalled latch | no heartbeat in the protocol (`heartbeat`: **0** occurrences in schema) | **Derivable, not given.** "Prompt outstanding and no `session/update` for N ms" is the same derivation we do now, on a cleaner input. |
| **`throttled`** | **nothing.** `rate_limit`, `throttl`, `retry` — **0** occurrences in the schema. `usage_update` reports token usage, not rate-limiting | **LOST.** This is the one attention state with no protocol equivalent. |
| done-unseen, awaiting-human | product state, not runtime state | **Unaffected** — ours either way. |

### 3d. The composer region: dissolved on one surface, still required on another

`src/runtime/composerRegion.ts` (239 lines) and the composer profiles in `runtimeProfile.ts` exist for
one reason: the composer belongs to someone else's TUI, so we must find it on a screen by parsing ANSI.
The file's own history says what that costs — a truecolor `38;2;r;g;b` run read as "dim" and made a
human's typed draft look like an empty composer (`t-3eaa8b`); a runtime echoing submitted messages made
Tachyon read its own notice as a human draft and refuse every later delivery (`t-6ffa13`).

**On an ACP surface this problem does not exist.** There is no shared composer to read: the human types
into our own input, so "is a human drafting?" is a boolean in our state, and `session/prompt` replaces
typing bytes and a separately-delayed Enter.

**But the machinery does not become deletable**, and this is the trap in the question. Layer 1 stays
forever by product decision, so agents will keep running as TUIs in panes, and `write_input`,
`notify_agent`'s held-human-draft guard and submission confirmation all keep needing the region reader
for those. What ACP removes is the need to *grow* that machinery for a chat; what it cannot do is retire
it.

So the honest scoring is: **ACP has no equivalent, and needs none — for its own sessions only.**

### 3e. The 23 Activity event types against ACP's 13

| our event | ACP | |
|---|---|---|
| `session.started` / `session.resumed` / `session.ended` | `session/new` · `session/load`+`resume` · `session/close` | ✅ we initiate these, so we know them exactly |
| `user.message.completed` | `user_message_chunk` | ✅ |
| `user.interrupted` | `session/cancel` → `StopReason: cancelled` | ✅ typed |
| `user.command` | `available_commands_update` (+ measured on grok, §1) | ✅ better than today |
| `assistant.message.completed` | `agent_message_chunk` | ✅ plus real streaming |
| `assistant.thinking` | `agent_thought_chunk` | ✅ first-class |
| `image.attached` | `promptCapabilities.image`, `ContentBlock: image` | ✅ per-runtime (grok measured `false`) |
| `tool.started` / `tool.completed` / `tool.failed` | `tool_call` + `tool_call_update`, `ToolCallStatus: pending·in_progress·completed·failed` | ✅ exact 1:1 |
| `file.referenced` / `file.changed` | tool-call locations and diff content blocks | ✅ richer (structured diffs) |
| `usage.updated` | `usage_update` | ✅ |
| `error` | JSON-RPC errors + `StopReason: refusal` | ✅ |
| `system.nudge` | ours to send via `session/prompt`; provenance stays ours | ✅ cleaner (no PTY typing) |
| **`context.injected`** | **nothing.** `inject`: **0** in schema | ❌ **GAP** — hook `additionalContext`, developer-role messages and `<environment_context>` preambles are runtime-internal; an ACP agent has no obligation to disclose them |
| **`compaction.boundary`** | **nothing.** `compact`/`summariz`: **0** in schema | ❌ **GAP** — and note grok exposes a `compact` *command*, so compaction happens; ACP just has no event for it |
| **`compaction.summary`** | **nothing** | ❌ **GAP** |
| **`file.snapshot`** | **nothing.** `snapshot`: **0** | ❌ **GAP** (runtime-specific today anyway) |
| `session.boundary` | partial — ACP session ids are stable, but an in-agent `/clear` need not be reported | ⚠️ weaker |
| `raw` | n/a — the fallback exists because transcripts are untyped; ACP is typed | ✅ moot |

**Score: 19 of 23 covered, most of them more precisely than today; 4 genuinely absent; 1 weaker.**
Every gap is the same shape — *events about the agent's own context management*. ACP models the
conversation, not the agent's internal housekeeping.

Two of the four gaps have a partial escape hatch: ACP defines a `_meta` field, and vendors already use
it heavily (measured: grok ships `x.ai/hooks`, `x.ai/fs_notify` and per-model reasoning-effort catalogs
inside `_meta`; Codex ships `steering` and a `_session/goal` control method). A runtime *could* report
compaction there. None does today, and depending on `_meta` means depending on one vendor's extension,
which is the parity problem we already have — not a solution to it.

---

## 4. What happens to the runtimes that do not speak — and to layer 2

The premise of question 4 was "if three of six speak ACP, is the answer two surfaces forever?" **The
measurement dissolves that premise: six of six speak it.** There is no permanently-excluded runtime to
plan around. But two surfaces still coexist, for a different and more stubborn reason.

**The reason is not protocol coverage. It is process ownership.** An ACP agent is a child process our
client spawns and holds on stdio. A Tachyon agent today is a TUI inside a tmux session, addressed by
pane. Those are different objects:

- `capturePane` / `capturePaneEscaped` — an ACP agent has no pane to capture.
- `write_input`, and `notify_agent`'s held-human-draft guard — no composer region exists to read, so
  the guard is neither needed nor implementable in its current form.
- AttentionMonitor's `#{window_activity}` selective-capture optimisation — no tmux window.
- Everything keyed on "the human can also open this in the integrated terminal" — layer 1's promise.

So layer 3 does not *replace* layer 2 for existing agents; it introduces **a second agent kind** whose
lifecycle, addressing and attention derivation are different. That is the real bill, it lands in the
Bridge and the roster rather than in the chat view, and none of the 6,041 lines the community wrote pays
any of it.

The mitigating measurement is §3b: because `session/list` and `session/load` read the same store the TUI
writes, the two kinds are not sealed off from each other. A chat surface could show the history of a
tmux-hosted agent even without driving it. That is a genuinely useful intermediate, and it is measured,
not hoped for.

**On Orca's zero ACP — I could not find out why.** Searched GitHub issues and the web for a public
record of the decision; nothing surfaced that states a reason. Reporting that as "not found" rather than
guessing: the task asked for a dated public source, and there is none to cite. What `t-5f4294` already
establishes stands on its own — they wrote four transcript decoders, cover 5 of 38 CLIs, and shipped a
disclaimer naming streaming, transcript fidelity and terminal parity as the seams, all three of which
are consequences of not having a protocol.

---

## 5. Recommendation

**Both, in order: start the ACP chat now as an additive second agent kind, and keep `t-e63164` alive but
descoped to what layer 1 needs forever.**

Not "chat instead of composer", and not "composer first". The reasoning:

**Why the chat should start now.** The three things that would normally make this a bad bet all came
back green, and all were measured: coverage is 6/6 rather than the assumed 3/6; the CSP question — the
one the task flagged as discoverable only by reading a bundle — is settled by a shipping MIT extension
running under `default-src 'none'`; and the two capabilities we feared losing (permission, resume) are
first-class, with a session load observed replaying real history. The protocol obligations are 546 lines
in a working implementation. Waiting does not make any of this cheaper.

**Why `t-e63164` should not be cancelled.** Layer 1 is forever by product decision. Agents will keep
running as TUIs in panes, and every one of them needs the send discipline the composer slice is about:
framing, the separately-delayed Enter, submission confirmation, and the composer-region guard that keeps
Tachyon from typing over a human's draft. ACP removes the need to *extend* that machinery into a chat;
it does not remove the machinery. What I would cut from `t-e63164` is any chat-shaped ambition in it —
the staging/composer *UI* is superseded by a real chat — while keeping the reader and the send
discipline, which are load-bearing regardless.

**Why not chat-only.** Because of §4: an ACP agent is not a pane, and the product's Bridge tools address
panes. Going chat-only would mean rebuilding agent addressing, attention and delivery for a second
object model before anything ships. That is a much larger change than the chat view, and none of it is
visible in the community's 6k lines.

**Sequencing I would defend:**

1. **Native three first — grok, opencode, hermes.** No third-party adapter in the dependency chain, and
   all three measured with `resume` + `list` + `loadSession`. This is where the protocol is a first-party
   promise from the runtime vendor.
2. **Read-only history second.** Because `session/list`/`session/load` read the store the TUI writes
   (measured), a chat surface can render a tmux-hosted agent's history before it can drive one. That
   ships value without forking the agent model.
3. **Adapters third, deliberately.** claude and codex adapters are official-org and actively maintained,
   but `claude-code-acp 0.16.2 → claude-agent-acp 0.66.0` in under five months is churn we would be
   signing up for, and the old name still worked while emitting a deprecation warning — so a pinned,
   probed version, not a floating one.
4. **`pi` last, and honestly labelled.** One maintainer, `0.0.33`, no `resume`, no `fork`. It should not
   be presented to an operator as equivalent to the other five.
5. **Keep `throttled` and the four missing event types on the record as known losses**, not as things to
   rebuild speculatively. `throttled` has no protocol equivalent at all.

**What would change my mind, stated so it can be checked rather than argued:**

- If live co-driving is required — a human in the TUI *and* our chat on the same running session — none
  of this is proven. I measured load-and-replay of a dead session only. Grok's `leader` mode advertises
  shared-backend, unmeasured. If the product needs co-driving, measure that before committing, because a
  negative result would make the chat a strictly separate agent kind with no bridge back.
- If losing `throttled` matters more than it appears, that is a real regression with no protocol answer.
- If the four missing event types (compaction, injected context) turn out to be load-bearing for
  Activity rather than decorative, ACP will not supply them and `_meta` would make us vendor-specific.

**And the honest framing of the whole result:** the task offered "the ACP covers less than the TUI and
the trade does not pay" as a legitimate and welcome outcome. It is not what the measurement says. ACP
covers *more* than the TUI on the axes we depend on most — permissions, resume, transcript, turn
boundaries — and less on exactly one axis, the agent's own context housekeeping. The cost that should
decide this is not protocol coverage at all; it is that we would be adopting a second agent object
model, and that cost is real, is in the Bridge, and is invisible in every line count quoted above.

---

## Where each number came from

| claim | command |
|---|---|
| six versions | `claude/codex/grok/opencode/hermes/pi --version` |
| six ACP handshakes | `node acp-probe.mjs … <cmd>` — writes one `initialize`, prints stdout |
| capability tables | the `agentCapabilities` object in each `initialize` result |
| codex app-server not ACP | same probe against `codex app-server` |
| pi rpc not ACP | same probe against `pi --mode rpc` |
| claude has no ACP | `claude --help \| grep -in "acp\|agent-client\|protocol"` → no match |
| session/list sees TUI sessions | `node acp-session-list.mjs … grok agent stdio` / `opencode acp` |
| session/load replays history | `node acp-load.mjs 45000 ses_05e89db97ffewf5YfHvTP5Ur8J /tmp/pcm-oc-EG0Hg9 opencode acp` |
| 38 methods, 13 update variants | `schema/schema.json` of `@agentclientprotocol/sdk@1.3.0` |
| 0 compact / inject / snapshot / heartbeat / attention | `grep -o <term> schema.json \| wc -l` |
| `acp-ui` is empty | `npm pack acp-ui` → 328 bytes → one `package.json` |
| use-acp CSP scan | `grep -ro <token> dist --include=*.js \| wc -l` |
| vscode-acp CSP + line counts | clone at `e7371659e3ac…`; `ChatWebviewProvider.ts:374`; `wc -l src/**` |
| package metadata/dates | `npm view <pkg> version license time.modified` |
| our own surfaces | `src/attention/AttentionMonitor.ts`, `src/runtime/composerRegion.ts`, `src/activity/types.ts` |
