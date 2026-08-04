# ide-browser-dogfood

Dev Host fixture for Integrated Browser + Design Mode.

**Clean roster:** no coding agents declared. Create them yourself in **Agent Studio**.

The only entry is `terminals.shell` (`cmd: sh`, `autostart: false`) — required so empty
`agents: {}` still loads. It is a **terminal**, not an agent.

**Manual UX (no auto-open):**

1. Point Dev Host at this fixture and launch EDH (`Tachyon: Dev Host` / F5).
2. Create agents (e.g. grok) in Agent Studio when you need them.
3. Status bar **globe** → Integrated Browser; **inspect** → Design Mode.
4. Design Mode chat persists to `.tachyon/design-mode-chat/chat.jsonl` (one file per workspace).

If the sidebar still shows ghost agents, wipe the live mirror runtime:

`.tachyon/dev-host/workspace/.tachyon/` (except settings import) and reload EDH.

Output channel: **Tachyon IDE Browser**.
