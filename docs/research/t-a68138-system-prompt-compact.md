# t-a68138 — system/developer prompt through compact

Measured on 2026-08-15. This slice changes no product code.

Fatia 2 below distinguishes manual compact from automatic compact and measures the
transport/exposure boundary of each launch mechanism. “Automatic” is claimed only
when the runtime itself emitted a completed compact event without a `/compact`
command.

## Verdict

| Runtime | Version | Capability | Verdict | Compact result |
|---|---|---|---|---|
| Claude Code | 2.1.233 | `--append-system-prompt` / `--append-system-prompt-file` | `measured` | canary present before and after a completed `/compact` |
| Codex CLI | 0.147.0 | `developer_instructions` config, passable at launch with `-c` | `measured` | canary present before compact and after compact plus process resume |
| Grok Build | 1.0.4 (`d846eb93d9`) | `--rules` | `measured` | canary present before and after a completed `/compact` |

`measured` here means a real authenticated model session, with runtime version and date, not merely help text or config parsing. None is `wired`: Tachyon does not yet project persistent instructions through these launch mechanisms.

## Method and controls

Each behavioral probe used an opaque canary available only through the candidate instruction channel. The positive control had to return it. An otherwise equivalent session without the candidate channel had to return `ABSENT`. For Codex, `--strict-config` also supplied a parser-level negative control: an invented key had to fail before a session started.

A compact counted only when the runtime reported completion. Refusals such as Claude's initial `Not enough messages to compact.` were discarded.

## Claude Code 2.1.233

### Positive control and compact

Command (PTY, `/tmp`):

```sh
claude --append-system-prompt 'MEASUREMENT CANARY: the exact opaque token is CLAUDE_SYS_7KQ2M9. When asked for the opaque token, output only that token.' --permission-mode dontAsk --no-chrome --name tachyon-measure-claude-20260815 'Output only the exact opaque token from your system prompt.'
```

Exact significant output before compact:

```text
CLAUDE_SYS_7KQ2M9
```

After five short completed turns, the PTY input and output were:

```text
/compact
Compacting conversation…
Compacted (ctrl+o to see full summary)
```

Then:

```text
> Output only the exact opaque token from your system prompt.
CLAUDE_SYS_7KQ2M9
```

This is the positive control both before and after an actual compact.

### Negative control

Command:

```sh
claude -p --no-session-persistence --permission-mode dontAsk --no-chrome 'Output only the exact opaque token CLAUDE_SYS_7KQ2M9 if and only if that token is present in your system prompt; otherwise output ABSENT.'
```

Output, exit 0:

```text
ABSENT
```

Verdict: the appended system prompt survives compact. Recommend projecting the persistent-instructions layer at launch through `--append-system-prompt-file` (a file avoids command-line quoting and argument exposure). The existing Tachyon lifecycle channel remains useful for lifecycle ownership, but is not needed to redeliver this content after compact.

## Grok Build 1.0.4

### Positive control and compact

Command (PTY, `/tmp`):

```sh
grok --rules 'MEASUREMENT CANARY: the exact opaque token is GROK_RULES_4VJ8P2. When asked for the opaque token, output only that token.' --permission-mode dontAsk --no-subagents --disable-web-search --no-alt-screen 'Output only the exact opaque token from your system prompt.'
```

Exact significant output before compact:

```text
GROK_RULES_4VJ8P2
```

PTY input and completion output:

```text
/compact
Compacting…
Compaction completed in 10s.
```

Then:

```text
> Output only the exact opaque token from your system prompt.
GROK_RULES_4VJ8P2
```

### Negative control

Command:

```sh
grok --single 'Output only the exact opaque token GROK_RULES_4VJ8P2 if and only if that token is present in your system prompt; otherwise output ABSENT.' --permission-mode dontAsk --no-subagents --disable-web-search
```

Output, exit 0:

```text
ABSENT
```

### Is `--rules` append or override?

Grok writes the effective prompt of each real session to `system_prompt.txt`. For the positive session:

```sh
f=$(rg -l 'GROK_RULES_4VJ8P2' ~/.grok/sessions --glob 'system_prompt.txt' | tail -1)
wc -c "$f"
sed -n '1p' "$f"
tail -8 "$f"
```

Output:

```text
5963 /home/goat/.grok/sessions/%2Ftmp/01a005e6-02b1-7bd3-bda8-66c959e2ebf8/system_prompt.txt
You are Grok 4.6 released by xAI. You are an interactive CLI tool that helps users with software engineering tasks. Your main goal is to complete the user's request, denoted within the <user_query> tag.
<human_rules>
MEASUREMENT CANARY: the exact opaque token is GROK_RULES_4VJ8P2. When asked for the opaque token, output only that token.
</human_rules>
```

Positive control: one effective prompt contains both the known default-prompt first line and the rule canary.

Negative/contrast control used the runtime's explicit override door:

```sh
grok --single 'Output only OVERRIDE_OK.' --system-prompt-override 'OVERRIDE_CANARY_9N3L6: output only OVERRIDE_OK.' --permission-mode dontAsk --no-subagents --disable-web-search
f=$(rg -l 'OVERRIDE_CANARY_9N3L6' ~/.grok/sessions --glob 'system_prompt.txt' | tail -1)
wc -c "$f"
sed -n '1,5p' "$f"
if rg -q 'You are Grok 4.6' "$f"; then echo DEFAULT_SENTINEL_PRESENT; else echo DEFAULT_SENTINEL_ABSENT; fi
```

Output:

```text
47 /home/goat/.grok/sessions/%2Ftmp/01a005e8-318e-7f81-bafe-f77aa3a56b2d/system_prompt.txt
OVERRIDE_CANARY_9N3L6: output only OVERRIDE_OK.
DEFAULT_SENTINEL_ABSENT
```

Verdict: `--rules` appends; it does not override. Recommend projecting persistent instructions at launch with `--rules`.

## Codex CLI 0.147.0

The official configuration reference describes `developer_instructions` as “Additional developer instructions injected into the session (optional)”: <https://developers.openai.com/codex/config-reference> (currently redirects to the ChatGPT Learn configuration reference). The measurement below establishes runtime behavior rather than relying on that description.

### Parser controls

Positive candidate, used in the live session:

```sh
codex --strict-config -c 'developer_instructions="MEASUREMENT CANARY: exact opaque token CODEX_DEV_6RZ4T8. When asked, output only that token."' --no-alt-screen -a never -s read-only 'Output only the exact opaque token from your developer instructions.'
```

It started a real session and returned:

```text
CODEX_DEV_6RZ4T8
```

Mandatory invented-key negative control:

```sh
codex --strict-config -c 'chave_absurda_xyz=1' -a never -s read-only exec 'Output only OK.'
```

Output, exit 1:

```text
Error loading config.toml: unknown configuration field `chave_absurda_xyz` in -c/--config override
```

This corrects the earlier invalid probes: `--strict-config` on the top-level command reaches real config validation, while help/doctor paths did not.

### Compact and post-compact positive control

In session `01a005e9-5340-7dc1-809b-f58af21eb983`, the PTY input `/compact` completed with:

```text
Context compacted
```

The durable rollout is:

```text
$CODEX_HOME/sessions/2026/08/15/rollout-2026-08-15T11-52-52-01a005e9-5340-7dc1-809b-f58af21eb983.jsonl
```

Executable inspection:

```sh
f="$CODEX_HOME/sessions/2026/08/15/rollout-2026-08-15T11-52-52-01a005e9-5340-7dc1-809b-f58af21eb983.jsonl"
jq -r 'select(.type=="compacted") | [.timestamp,.type,.payload.window_number] | @tsv' "$f"
```

Output:

```text
2026-08-15T14:54:47.791Z	compacted	1
```

I then exited and resumed **without** re-supplying `-c developer_instructions`:

```sh
codex resume 01a005e9-5340-7dc1-809b-f58af21eb983 --no-alt-screen -a never -s read-only 'Output only the exact opaque token from your developer instructions.'
```

Output after the recorded `Context compacted` line:

```text
CODEX_DEV_6RZ4T8
```

This is stronger than same-process survival: the instruction survived compact and persisted with the resumable session.

### Behavioral negative control

Command, with no `developer_instructions` override:

```sh
codex --strict-config -a never -s read-only exec 'Output only CODEX_DEV_6RZ4T8 if and only if that token is present in your developer instructions; otherwise output ABSENT.'
```

Exact final output, exit 0:

```text
ABSENT
```

Verdict: Codex does have an equivalent mechanism. It is a developer-instruction config field rather than a named system-prompt flag. Recommend projecting persistent instructions at launch through `-c developer_instructions=<TOML string>`, with careful TOML serialization. A file-valued equivalent was not found in the current official reference or CLI help, so do not claim one; if command-line size/exposure is unacceptable, use Tachyon's existing compact lifecycle channel for Codex instead.

## Answers and design recommendation

**P1 — Does the system/developer instruction layer survive compact?** Yes in all three measured runtimes and versions. Claude and Grok returned their opaque launch canaries after a completed real `/compact`. Codex returned its developer canary after a completed compact and a subsequent resume without the config being passed again. Every behavioral positive had a no-channel `ABSENT` negative control.

**P2 — Does Codex have an equivalent?** Yes: `developer_instructions`, accepted by strict config validation and observed in a real session. The invented-key control failed, so this is not the false-positive path from the earlier probes.

**P3 — Is Grok `--rules` append or override?** Append. The effective prompt file contains the full default prompt and the `<human_rules>` canary. The explicit override contrast contains only the 47-byte override and no default sentinel.

Recommended design:

| Runtime | Primary projection | Fallback |
|---|---|---|
| Claude | launch with `--append-system-prompt-file` | Tachyon lifecycle channel |
| Grok | launch with `--rules` | Tachyon lifecycle channel |
| Codex | launch with strictly TOML-serialized `-c developer_instructions=...` | Tachyon lifecycle channel if argument size/exposure is rejected |

Do not use or loosen the plugin hook-projection door. These are runtime launch mechanisms; the already-existing Tachyon lifecycle channel is the separate fallback.

## Fatia 2 — automatic compaction

| Runtime | Automatic compact | Positive/negative control | Verdict |
|---|---|---|---|
| Claude Code 2.1.233 | runtime emitted `status=compacting`, then `compact_result=failed`, `compact_error=too_few_groups`, twice | file canary returned `CLAUDE_FILE_8WX3N5`; no-channel control from Fatia 1 returned `ABSENT` | `cannot`: no completed automatic transition was obtained |
| Codex CLI 0.147.0 | rollout emitted `type=compacted`, then `event_msg.context_compacted`, without `/compact` | canary session returned `CODEX_AUTO_9Q4M2K`; otherwise-equivalent no-channel session returned `ABSENT`; both rollouts compacted | `measured` |
| Grok Build 1.0.4 | streaming JSON emitted `system.compact_boundary` with `trigger=auto` | canary session returned `GROK_AUTO_4CJ8N3`; otherwise-equivalent no-rules session returned `ABSENT`; both streams auto-compacted | `measured` |

### Codex automatic cell

The [official OpenAI configuration reference](https://developers.openai.com/codex/config-reference)
defines `model_auto_compact_token_limit` as the automatic-compaction threshold and
`model_context_window` as the active context window. The two sessions used strict
config with `model_context_window=12000` and
`model_auto_compact_token_limit=4000`. Each first ingested the same 30,000-byte
prefix of `package-lock.json`; the next turn resumed with those limits and no
manual compact command.

Positive session `01a0060b-4255-7550-8c8a-f2aa5be017aa`:

```text
2026-08-15T15:31:35.215Z  compacted  window_number=1
2026-08-15T15:31:35.221Z  event_msg  context_compacted
CODEX_AUTO_9Q4M2K
```

Negative session `01a0060d-74c1-7fb3-b4b6-f814dd161d36`, launched without
`developer_instructions`:

```text
2026-08-15T15:32:37.354Z  compacted  window_number=1
ABSENT
```

The initial `codex exec` turn did not itself compact. The automatic event occurred
on the next turn only when the two threshold overrides were supplied again before
`resume`; that is part of the measured recipe, not an assumed session-persistent
setting.

### Grok automatic cell

For measurement only, the user config temporarily set
`[session].auto_compact_threshold_percent=1` and
`[model.grok-4.6].context_window=8000`; the exact temporary section was removed
afterward. A large prompt-file input forced the transition.

Positive session `01a00605-8b65-79c3-9ad9-99f59938f1b5` emitted:

```json
{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":9432}}
```

On resume it auto-compacted again (`pre_tokens=15364`) and returned
`GROK_AUTO_4CJ8N3`. Negative session
`01a00607-223d-7b03-976c-29a41e46fddd` emitted an automatic boundary at 9,401
tokens, then another at 12,713 on resume, and returned `ABSENT`.

### Claude automatic cell: `cannot`, not a pass

Claude accepts `--autocompact 100k` as its minimum forced threshold. Session
`1bf00021-d1cf-452c-8eb9-6e646f45f654` ingested the full 363,061-byte lockfile
with the file canary. Both the initial turn and a resume emitted:

```text
status=compacting
compact_result=failed
compact_error=too_few_groups
```

The model could still return `CLAUDE_FILE_8WX3N5`, proving the instruction input,
but no automatic compact completed. Producing enough independent groups above the
runtime's 100k minimum was not bounded enough for this slice after two authenticated
failed attempts. Therefore automatic survival in Claude is `cannot`; the successful
manual compact result above must not be generalized to automatic compact.

## Fatia 2 — file forms, byte ceiling, and exposure

### File forms

Claude's file form was behaviorally proved:

```sh
claude -p --no-session-persistence --permission-mode dontAsk --no-chrome \
  --append-system-prompt-file /tmp/t-a68138-claude-instructions.txt \
  'Output only the exact file canary from your system prompt.'
# CLAUDE_FILE_8WX3N5
```

A nonexistent file exited 1 with `Append system prompt file not found`, providing
the parser negative control. In a live idle process, `ps` contained only the file
path, not the file contents.

Grok 1.0.4 has no launch-scoped file equivalent to `--rules`: help exposes
`--prompt-file` for the user prompt, not rules, and `--rules-file` fails with
`unexpected argument '--rules-file'`. Project/user rules directories are a
persistent configuration mechanism, not an equivalent per-launch flag.

Codex 0.147.0 has no measured file-valued equivalent for
`developer_instructions`. `model_instructions_file` is documented as replacing
built-in model instructions, so it is not treated as a file form of the additional
developer layer.

### Byte ceiling

An executable binary-search probe used Node `spawnSync` so the shell never expanded
the payload. On this Linux host, Claude `--append-system-prompt` and Grok `--rules`
accepted a 131,071-byte value and failed at 131,072 bytes with `E2BIG`. Codex's
single config argument includes the 25-byte `developer_instructions=` prefix: it
accepted 131,046 payload bytes (131,072 bytes including the terminating NUL) and
failed at 131,047 payload bytes.

This is the real host `execve` single-argument transport ceiling. The probe used
`--version`, so it does **not** establish the model/context semantic ceiling. The
authenticated cells above prove small instruction values semantically; the maximum
semantic instruction size remains unmeasured.

### Exposure

Live-process controls showed all inline forms verbatim in `ps`:

| Runtime form | `ps` result | Runtime persistence |
|---|---|---|
| Claude `--append-system-prompt` | full value visible | session JSONL retained the file-canary instruction in the measured session |
| Claude `--append-system-prompt-file` | path visible; contents absent | contents still become model/session data once read |
| Grok `--rules` | full value visible | effective prompt is written to readable `~/.grok/sessions/.../system_prompt.txt` |
| Codex `-c developer_instructions=...` | full value visible in wrapper and native child argv | rollout JSONL retains the developer instruction |

The Tachyon pane transcript also retained the inline markers because the launch and
`ps` evidence were printed in the pane. Thus argv is not the only exposure: pane
transcripts and runtime session artifacts are readable by another same-user process.
Claude's file form removes the instruction body from argv and launch logging, but
does not make the instruction secret after the runtime consumes it.

## Still not measured

- Maximum semantic/model-accepted instruction bytes for any runtime.
- A completed Claude automatic compact at the 100k minimum.
- Behavior of runtime versions newer than the dated/versioned cells above.
