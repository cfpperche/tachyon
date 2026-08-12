# Orca's "Chat UI": where it lives, what feeds it, and who talks to the provider

_2026-08-12. Source read, not documentation: `stablyai/orca`, MIT, commit
`09ec516ae50b7b83fa65343d9ad96159e3fe71fc` ("fix(editor): index WSL watcher aliases per batch
(#14015)", 2026-08-12 03:24:31 -0700)._

**Reproducing this.** There is no local clone in the product repo and none was created there. The
tree was cloned to a throwaway directory outside `/home/goat/tachyon`:
`…/scratchpad/orca-src` under the session scratchpad
(`/tmp/claude-1000/-home-goat--cache-tachyon-worktrees-b349073a-orcachat/fda2f730-c6b4-458c-b749-1c2c9699c9b3/scratchpad`).
Every line reference below is against the commit above. To re-check in a month:
`git clone https://github.com/stablyai/orca && git checkout 09ec516a`. No code from that
repository was copied into ours — the citations are paths, line numbers, and short quotes.

Drift note, and it is the reason the commit matters: the previous Orca research
(`orca-orchestration-task-lifecycle-land.md`, commit `34f2a62`) cites `merge --abort` at
`src/main/git/status.ts:1052`. At `09ec516a` that call is at `status.ts:1066`. The claim held; the
line moved in three days.

---

## The verdict, first

**The feature is called `native-chat` in the code, never "chat UI" outside of user-facing strings.**

The owner offered three hypotheses for where the conversation comes from. Orca's own type file names
**all three, ranks them, and ships two of them**:

```
src/shared/native-chat-types.ts:15
export const NATIVE_CHAT_SOURCES = ['transcript', 'hook', 'scrape'] as const
                                    priority 3     2       1        (:21-25)
```

- **transcript** — the JSONL file the CLI writes to disk. This is the conversation. **Primary.**
- **hook** — the CLI's own hook mechanism, posting events to an HTTP server Orca runs. Supplies the
  session id, the authoritative transcript path, liveness, the interactive-question payload, and the
  "streaming" preview. **Secondary, and it is what makes the view feel live.**
- **scrape** — parsing the terminal scrollback. Written, unit-tested, and **wired to nothing.** In
  production the name survives only as the tag for the operator's own optimistic echo.

**A structured conversation protocol from the CLI — stream-json, ACP — is used ZERO times.** Counted:
`grep -c 'stream-json|acp|agent-client-protocol|jsonrpc'` across all 283 `native-chat` files returns
**0**. `agent-client-protocol`/`ACP` appears in **0 files** in the entire repository. Orca does use
`--print stream-json` exactly twice in the tree, and neither is the chat: one lists Claude's model
catalog (`src/shared/claude-model-list-probe.ts:15`), one generates commit messages
(`src/shared/commit-message-agent-spec.ts:333`).

**And the operator sends by writing bytes into the PTY** — bracketed paste, then a separately-delayed
carriage return. Same door we use.

So: **Orca did not build our layer 3.** It built a chat-shaped façade over layer-2 plumbing. That
distinction is the whole finding, and section 7 spends it.

---

## 1. Where the Chat UI lives, and what it replaces

It replaces **nothing**. It is an opaque overlay painted on top of a pane whose terminal is still
running underneath.

```
src/renderer/src/components/terminal-pane/TerminalPane.tsx:3031-3034
{effectiveChatViewMode && chatPane?.container
  ? createPortal(
      <div className="absolute inset-0 z-10 flex min-h-0 min-w-0 bg-background">
        <NativeChatView …
```

`createPortal` into `chatPane.container` — the pane's own DOM node, the same one xterm renders into.
`absolute inset-0 z-10` with an opaque `bg-background` covers it. The xterm instance, its addons, and
the PTY behind it all stay alive; only the pixels are hidden. Proof they stay alive: the chat asks the
still-mounted terminal for its screen —

```
src/renderer/src/components/terminal-pane/TerminalPane.tsx:686-692
const readNativeChatTerminalScreen = useCallback((): string | null => {
  …
  return pane?.serializeAddon.serialize({ scrollback: 0 }) ?? null
```

Granularity is the **leaf pane**, not the tab: `chatLeafId`, `toggleNativeChatForLeaf`
(`TerminalPane.tsx:655`). One split can be chat while its sibling stays a terminal.

Toggle gating: `experimentalNativeChat` (the switch) plus `openAgentTabsInChatByDefault` (the "Default
view" selector), both in `src/renderer/src/components/settings/NativeChatExperimentalSetting.tsx:22-23`.
Eligibility per pane is decided by a pure function, `canToggleNativeChat`
(`src/renderer/src/components/native-chat/native-chat-availability.ts:41`).

**Size.** 283 files carry `native-chat` in their path; 160 are not tests; those 160 are **19,160
lines**. That excludes the hook infrastructure the chat depends on
(`src/shared/agent-hook-listener.ts` alone is 4,519 lines; `src/main/agent-hooks/server.ts` is 2,907).

## 2. Where the conversation content comes from

**Read from the JSONL transcript the CLI writes to disk.** Their own loading copy says so:
`"Reading the agent transcript."` (`src/shared/native-chat-empty-state.ts:12`).

Entry point, and note that it reads the whole file with no cap:

```
src/main/native-chat/transcript-reader.ts:39
export async function readNativeChatTranscript(agent, sessionId, options)
```

It dispatches to one hand-written decoder per CLI (`transcript-reader.ts:49-61`):

| CLI | decoder | lines |
|---|---|---|
| Claude (and OpenClaude) | `transcript-line-decoders-claude.ts` | 84 |
| Codex | `transcript-line-decoders-codex.ts` | 239 |
| Grok | `transcript-line-decoders-grok.ts` | 247 |
| OMP | `transcript-line-decoders-omp.ts` | 227 |

Finding the file at all is its own subsystem, `session-file-resolver.ts`, because every CLI hides it
somewhere different — `~/.claude/projects/<slug>/<id>.jsonl` globbed by id (`:111`), Codex rollout
files under date-nested dirs in an Orca-managed `CODEX_HOME` (`:35-41`), `~/.grok/sessions`,
`~/.omp/agent/sessions` (`:43-54`). The hook-reported path wins when present, and the comment explains
why the fallback exists at all:

> "recent Claude Code names the transcript file with a UUID that differs from the hook session_id (so
> the id-based glob no longer finds it)" — `src/shared/agent-session-resume.ts:187-189`

Liveness on top of the file: a watch/tail stack (`transcript-watch.ts`, `transcript-watch-engine.ts`,
`transcript-tail-reader.ts`, `transcript-incremental-reader.ts`, `transcript-read-cache.ts` — 24
non-test files under `src/main/native-chat/`).

**The scrape tier is dead code in production.** `scrapeNativeChatSession`
(`native-chat-scrape-fallback.ts:117`) has exactly **one** caller and it is
`native-chat-scrape-fallback.test.ts`. The single production call to the assembler passes one source:

```
src/renderer/src/components/native-chat/native-chat-live-message-preparation.ts:18-19
return assembleNativeChatSession({
  sources: { transcript: surfaced },
```

The `'scrape'` string does appear in shipping code, but as the priority label for the operator's own
not-yet-confirmed send (`native-chat-pending.ts:221`, `:255`, `:378`) — an optimistic bubble pruned
when the real user turn lands in the transcript. That is a rank, not a screen reader.

**What the screen read at `TerminalPane.tsx:691` is actually for:** session options — reading which
model the TUI currently shows (`use-native-chat-session-options.ts:119`, `:180`) and confirming a
model switch landed. Never the conversation.

**Consequence.** No transcript, no chat. There is no degraded mode in the shipped path — the view
shows `"The transcript could not be read. Toggle back to the terminal to keep working."`
(`native-chat-empty-state.ts:20`).

## 3. How the operator sends

**Into the PTY, as bytes.** There is no structured input door. Counted: `fetch(` appears **0 times**
across all `native-chat` files.

The sequence is documented in their own comment (`native-chat-runtime-send.ts:127-130`):

> 1. clear any unsubmitted TUI line
> 2. write framed body
> 3. delayed Enter (separate write — same-write CR can be swallowed by paste)

Each step is a fight with the TUI:

- **Framing** (`native-chat-send.ts:34`): multi-line → bracketed paste `\x1b[200~…\x1b[201~`;
  single-line → sanitized raw text.
- **Enter is separate and delayed** (`native-chat-send.ts:29-32`), 500 ms
  (`NATIVE_CHAT_SUBMIT_DELAY_MS = 500`, `src/shared/native-chat-answer-stepping.ts:1`), because "agent
  TUIs treat a framed paste that carries a trailing `\r` in the SAME pty write as part of the paste
  body rather than an Enter, so the text lands in the input box but never sends."
- **Clearing the line first** costs a measured burst. `buildAgentTuiClearInput`
  (`src/shared/agent-tui-input-clear.ts:13`) emits `2N-1` Ctrl+U **plus** `2N-1` Ctrl+K, with 8 lines
  of slack always added (`:29`) and a cap of 40 (`:32`). Their own measurement note: **"41 Ctrl+U
  against a 1-line buffer measured perfectly clean on both agents"** (`:26-27`) — overshoot is
  deliberate, because "an undershoot is what leaves residue to glue onto the next message". The widest
  burst, `AGENT_TUI_CLEAR_INPUT_MAX` (`:35`), is `buildAgentTuiClearInput(40)` = 79 Ctrl+U + 79 Ctrl+K
  = **158 control bytes to empty one input line**.
- **Serialization** (`native-chat-pty-send-queue.ts:1-7`): a per-PTY queue exists solely because the
  delayed Enter creates a window in which a second send's clear can "glue or race the agent composer".
- **Answering a question** is per-option keystrokes, not text, because pasting the label commits the
  wrong option: "pasting 'Blue' + Enter commits the highlighted FIRST option — STA-1860"
  (`src/shared/native-chat-agent-support.ts:26-29`). Approvals are literally `'1'` for Allow and
  `ESC` for Deny (`native-chat-interactive-prompt.ts:76-77`).

## 4. How they talk to the LLM provider

**They do not. Not once, on any chat path.** The conversation is produced entirely by the guest CLI,
under the CLI's own credentials, in the CLI's own process.

Counted, at `09ec516a`:

- LLM inference SDKs in any `package.json` in the repo (3 of them): **0**. No `@anthropic-ai/*`, no
  `openai`, no `@ai-sdk/*`, no LangChain.
- Direct calls to a chat/completions endpoint anywhere in `src/`: **0**.
- Outbound provider HTTP in `native-chat` files: **0**.

Provider hostnames do appear in `src/`, and every one is something other than inference:

| what | file:line | why it is not inference |
|---|---|---|
| `https://api.openai.com/v1/audio/transcriptions` | `src/main/speech/openai-transcription-client.ts:8` | speech-to-text for dictation |
| `https://api.anthropic.com/api/oauth/usage` | `src/main/rate-limits/claude-fetcher.ts:46` | reads the user's quota |
| `https://api.anthropic.com/` | `src/main/network/proxy-settings.ts:25` | reachability probe |
| `https://api.openai.com/auth` \| `/profile` | `src/main/codex-accounts/codex-auth-identity.ts:167-168` | JWT claim keys, read locally |
| `platform.minimax.io/.../coding_plan/remains` | `src/main/rate-limits/minimax-request-context.ts:4` | reads the user's quota |

**The one direct provider call, and its credential.** Dictation posts audio to OpenAI with a key the
user pastes into Settings, encrypted with Electron `safeStorage` and written to
`~/.orca/openai-speech-token.enc` at mode `0o600`
(`src/main/speech/openai-api-key-store.ts:10`, `:50-58`). Errors are scrubbed of `sk-…` before display
(`openai-transcription-client.ts:19-29`). It has nothing to do with the chat view.

**Auxiliary LLM work also goes through the CLI binary, never the API.** Commit-message generation
spawns the guest CLI headless — `claude -p --output-format text --model … --permission-mode plan`,
prompt on stdin (`src/shared/commit-message-agent-spec.ts:325-340`). Model discovery sends one
`{"type":"control_request",…"subtype":"list_models"}` over `--print stream-json`
(`src/shared/claude-model-list-probe.ts:8-22`). Both use the CLI's credentials, not Orca's.

**What decides which path runs: nothing does, because there is no second path.** There is no
API-vs-CLI branch to describe.

## 5. What makes a CLI "supported" — the per-runtime cost

The list is five strings:

```
src/shared/native-chat-agent-support.ts:4-10
NATIVE_CHAT_SUPPORTED_AGENTS = new Set(['claude','openclaude','codex','grok','omp'])
```

Against **38 CLIs** Orca launches (`src/shared/types.ts:2636-2672`). **5 of 38 — 13%.** Gemini is
named in the code as the example of an agent that never qualifies
(`native-chat-availability.ts:38-39`). And `openclaude` is free: it "writes the Claude transcript
format and layout", so it reuses Claude's decoder (`native-chat-agent-support.ts:41-44`). Four real
integrations, not five.

To be supported, a CLI must supply **three** things, and each has a per-CLI price:

1. **A parseable transcript on disk.** One hand-written decoder per format (84–247 lines, section 2)
   plus one path-resolution strategy per CLI, because none of them agree on where the file goes
   (`session-file-resolver.ts:22-54`).
2. **A hook that discloses the session id**, so the right transcript can be found. Orca writes into
   the CLI's own config to install it (`src/main/agent-hooks/hook-config-write-path.ts`), and every CLI
   names the field differently: `session_id`, `conversationId`, `sessionID`, `sessionId`, `session_file`
   — 18 `case` labels collapsing to 9 outcomes at `src/shared/agent-session-resume.ts:186-239`. Five CLIs in that switch
   (`amp`, `cursor`, `command-code`, `copilot`, `hermes`) `return null`: no id, no chat, ever.
3. **Keystroke behavior Orca has characterized.** Which agents step answers option-by-option
   (`shouldStepNativeChatAskAnswer`, `:32`), which accept an image paste
   (`native-chat-image-paste.ts:30`), what clears their input line
   (`agent-tui-input-clear.ts`). This is measured per TUI, not derived.

There is a fourth cost that is not a capability but a deployment truth: when the hook discloses no
transcript path, Orca must scan a sessions root **on a disk this process can read** — so under
SSH-to-a-remote-host, Grok and OMP chat is refused rather than shown loading forever
(`native-chat-agent-support.ts:16-22`, enforced at `native-chat-availability.ts:52-57`).

## 6. What they admit does not work

Their screen says "experimental while we tune **transcript fidelity, streaming, and terminal
parity**". All three are visible in the code.

**Streaming — there is none.** The live bubble is a hook preview, not a token stream:

> "While an agent works, its hook preview (`lastAssistantMessage`) is shown as a **synthetic assistant
> message** … before the completed turn is flushed to the transcript."
> — `src/shared/native-chat-streaming.ts:1-5`

It is suppressed the moment the transcript catches up
(`deriveNativeChatStreamingText`, `:34-52`). So the granularity of "streaming" is whatever cadence the
CLI's hook fires at, and the fidelity is whatever that hook chose to include.

**Transcript fidelity — the file is a lagging, racing artifact.** `notFound` is a distinct,
retry-worthy result because "transcript not flushed to disk yet, #8401"
(`transcript-reader.ts:23-25`), and an `ENOENT` *after* a successful resolve is treated the same way
because of "first-flush/rotation race" (`:64-66`). Unknown record types are skipped rather than raised
(`:35-37`) — a format change degrades silently into missing messages, not into an error.

**Terminal parity — the chat hands you back to the terminal when it runs out of road.** The composer
wires the agent-picker action straight to "switch to terminal"
(`NativeChatComposer.tsx:235`: `onAgentPicker: onSwitchToTerminal`). Slash commands are a curated
hand-written list, because "the CLIs ship no machine-readable command list, so these track the common,
stable commands each TUI documents" (`src/shared/native-chat-slash-commands.ts:16-18`). Image paste is
`'unsupported'` for every agent outside a small allowlist (`native-chat-image-paste.ts:13`, `:30`).

**Two more they do not advertise.** A model switch has to *watch the PTY* to confirm it landed, and the
chat's own delayed Enter is a hazard to it: option commands must cancel and drain the send queue first
"so a delayed chat Enter cannot land on Claude's model confirmation dialog"
(`native-chat-pty-send-queue.ts:6-7`, `native-chat-runtime-send.ts:190`). And the question selector bug
(STA-1860) means the operator's typed answer cannot be sent as text at all.

---

## 7. What this means for our layer 2 and layer 3

Our architecture doc defines layer 3 as: *"Replace the runtime TUI with product UI **on a protocol**
(ACP / Codex app-server / stream-json / SDK)"* (`docs/architecture/agent-pane-first-party-surface.md:16`).

**By that definition, Orca's Chat UI is not layer 3.** It has the product UI and none of the protocol.
It reads files the CLI happens to write, listens to events the CLI happens to emit, and types
keystrokes into the same PTY layer 2 drives. The TUI is still there, still running, still
authoritative — it is behind an opaque div, and the chat asks it questions when it needs to know
something the transcript cannot tell it.

That makes this evidence about a **different** thing than we went looking for, and the different thing
is more useful:

- **It is not evidence that layer 3 is cheap.** Nobody in this tree paid for layer 3. What was
  measured is the cost of a chat façade without a protocol: ~19k lines, four decoders, a 4.5k-line hook
  listener, 13% CLI coverage, and a shipped disclaimer naming the three seams.
- **The seams are all in the same place — the boundary the façade cannot cross.** Streaming is a hook
  preview because the PTY carries no tokens. Fidelity races because the transcript is a file, not a
  stream. Parity breaks at the agent picker because the picker lives in the TUI. Every admitted defect
  is a consequence of not having the protocol, not of the UI being unfinished.
- **The parts we would share with them, we already have or already need.** The 158-byte input clear,
  the framed paste, the separated delayed Enter, the per-PTY send serialization — that is layer-2 send
  discipline, and it is required whether or not a chat view ever exists. Orca's version of it is a
  measured artifact worth comparing against ours when `t-e63164` builds the composer.
- **The per-runtime tax is the number to carry forward.** For us, "supported" would mean the same three
  things — a decodable transcript, a hook that names the session, and characterized keystroke behavior
  — priced per runtime, against runtimes that change constantly. Orca launches 38 CLIs and can render
  4 formats.

Nothing here reopens the decision to keep the TUI visible, and no change of course is proposed — that
is the owner's call. The one correction it makes to our map is that **the option the Chat UI
demonstrates is not the layer 3 we wrote down.** There is a rung between 2 and 3 that our table does
not name: product chat UI, no protocol, TUI still live underneath. Orca is standing on it, and it is
shipping with a warning label.

---

## Where a number came from

| claim | how it was counted |
|---|---|
| 283 / 160 files, 19,160 lines | `find src -ipath '*native-chat*' -type f` and `… -not -name '*.test.*'` |
| 38 CLIs | union members, `src/shared/types.ts:2637-2672` |
| 5 native-chat agents | set literal, `src/shared/native-chat-agent-support.ts:4-10` |
| 0 stream-json / ACP / jsonrpc in native-chat | grep over the 283 files |
| 0 ACP anywhere | `grep -rl 'agent-client-protocol\|ACP' --include=*.ts src` |
| 0 `fetch(` in native-chat | grep over `renderer/…/native-chat`, `main/native-chat`, `shared/native-chat-*` |
| 0 LLM SDK deps | grep over all 3 `package.json` |
| scrape has 1 caller, its own test | `grep -rn 'scrapeScrollbackToMessages\|scrapeNativeChatSession'` across `src` and `mobile` |
