# Cookbook — doorbell-read-inbox

_Operator/agent how-to for this shipped surface. Not the contract (`spec.md`) and not build memory (`notes.md`).
Write at ship time when the change introduces a usable API, Bridge tool, CLI, or lifecycle that a sibling agent
or human would otherwise reverse-engineer from code._

## When to use

- You're a coordinator that has been busy (working, or restarted) for a while and want to know what
  `notify_agent` doorbells rang for you in that window, without depending on having been idle at the
  exact moment a queued notice flushed to your pane.
- You just came back from a compaction/restart and want to catch up on completion reports a delegated
  child sent while you weren't watching.

## When not to use

- You want to know if a CHILD is currently waiting for input, rate-limited, or dead — that's a
  `host-poke`-origin notice (Tachyon's own backstop), and `read_notices` deliberately does not carry
  those; they're a claim about live state that goes stale the moment the child's state changes. Use
  `list_agents`/`read_output` for that instead.
- You want to inspect another agent's inbox — `read_notices` is self-only by design (no `to` parameter).
  There is no cross-agent read.
- You want guaranteed, acknowledged, at-least-once delivery — this is still best-effort pane delivery
  underneath (spec 341, unchanged). This tool only makes the RECORD of what rang durable and readable;
  it does not change delivery semantics or add read receipts.

## Happy path

1. Call `read_notices(agent: "<your name>")` (your own resolved identity — same as `notify_agent`'s
   `agent` param, never guessed).
2. Read back `{ notices: [{ from, at, summary, pointer }], returned, truncated }`, oldest-first, capped
   at 200 per call. Omitting `since` starts from the OLDEST matching notice, not the most recent — see
   step 4 for why.
3. Remember the highest `at` you saw. Next time, call
   `read_notices(agent: "<your name>", since: "<that at>")` to get only what's new — you own the cursor,
   there is no server-side "already read" state.
4. If `truncated: true`, there were more than 200 matching notices; page forward with `since` set to the
   last item's `at` in this batch rather than assuming you saw everything.

## Tools / commands

| Action | Tool or command | Notes |
|--------|-----------------|-------|
| Read what rang for you | `read_notices(agent, since?)` | Self-only; `since` is an ISO 8601 cursor, exclusive (`at > since`). Omit to start from the oldest matching notice (capped at 200, `truncated` says if more remain). |
| Send a doorbell (unchanged) | `notify_agent(to, summary, pointer?, agent)` | Still best-effort pane delivery on the recipient's next idle turn; now also durably witnessed with content, which is what `read_notices` reads back. |

## Fail-closed / safety

- `agent` is resolved against the Bridge-authenticated caller when auth is on — you cannot read another
  identity's notices by declaring a different name (same rule as `notify_agent`'s `agent` param).
- No `to`/target parameter exists at all — there is no way to widen this into a cross-agent inspection
  tool short of a code change to the tool's own schema.
- Host-poke-origin notices are never witnessed into `.tachyon/doorbells.jsonl` in the first place, so
  there's nothing to accidentally leak from that class of notice.

## Cleanup

None — `read_notices` is a pure read; it does not mutate `.tachyon/doorbells.jsonl` or mark anything as
read. The file itself is append-only and shares the lifecycle of the workspace's `.tachyon/` directory
(no rotation added by this spec — see `plan.md` Risks & unknowns).

## See also

- Contract: [`spec.md`](./spec.md)
- Superseded non-goal: `docs/specs/341-notify-agent-idle-delivery/spec.md` (the delivery mechanism this
  read door sits next to — pane delivery, the `working→idle` drain, and the 10-minute TTL are unchanged).
