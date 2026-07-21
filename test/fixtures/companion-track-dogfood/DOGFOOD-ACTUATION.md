# Dogfood — Companion first-person (multi-runtime)

**Ship note:** screenshot → workspace path + vision (`user_browser_screenshot` → path under
`.tachyon/companion/screenshots/` + runtime file/image read) is **done**. Do not re-open re-encode
unless vision regresses.

This run validates **actuation honesty + leaf insert**, and that tools are **listable when
settings.companion.tabTools is true** (even before pair; call fails clearly if unpaired).

## Pre-flight (human)

1. EDH: **Tachyon: Dev Host** F5 (companion-track pointer).
2. Chrome extension **≥ 0.4.4** (Load unpacked release folder).
3. Fixture has `settings.companion.tabTools: true` (tools on Bridge tool list without pair).
4. Pair Companion + Agent tab access ON (required to *execute*, not to *see* tools).
5. Open the smoke fixture in the **active** tab:
   - Prefer:
     `…/test/fixtures/companion-track-dogfood/actuation-smoke.html`
     (file:// or static server).
   - Optional hard case after green on fixture: x.com composer.

## Prompt (any Bridge agent: Grok / Claude / Codex / …)

```
# Mission: validate Companion actuation honesty + screenshot path (0.4.4+)

Use ONLY Companion tab tools (user_browser_*). No agent-browser/CDP. No eval-to-type.

Runtime-neutral: for reading a screenshot path use read_file OR this runtime's
equivalent file/image-read tool. Do NOT fail Gate B only because the tool name
is not "read_file".

Expected active tab: actuation-smoke.html with #native-input and #rich-editor.

## A — Tool list + pair (do NOT stop on search-only failure)
1. This workspace has settings.companion.tabTools: true — user_browser_* MUST appear
   in MCP tools/list (or the runtime MCP catalog). Empty search_tool / ToolSearch alone
   is NOT proof of "not paired" or "tools missing".
2. Prefer tools/list or a direct call. Use qualified names if required
   (e.g. tachyon_bridge__user_browser_snapshot).
3. user_browser_snapshot once; note url + title.
4. Report not paired ONLY if a call returns an error that settings.tabTools is enabled
   but no browser is paired — not because discovery search was empty.

## B — Screenshot path (regression)
1. user_browser_screenshot (jpeg default ok).
2. Assert tool JSON:
   - ok: true, kind: "screenshot"
   - path starts with `.tachyon/companion/screenshots/`
   - has url, title, mimeType, byteLength, format
   - does NOT include dataUrl or any long base64 blob
3. Read that path with the runtime file/image tool and confirm first-person vision.

## C — Native field (fixture)
1. user_browser_fill selector `#native-input` value `tachyon-native-fill-smoke`
2. Expect ok:true and verified:true (or visibleText containing the marker).
3. Confirm via snapshot and/or screenshot+vision.
- If ok:false code not_applied → FAIL actuation (honesty working).
- If ok:true but marker absent → FAIL honesty bug.

## D — Contenteditable (fixture)
1. user_browser_click `#rich-editor` if needed.
2. user_browser_type or fill `#rich-editor` with `tachyon-ce-dogfood-smoke`
3. Expect ok:true only if the marker really lands (verified / visibleText).
4. Confirm with screenshot vision OR snapshot text. If snapshot truncates,
   screenshot + image read is mandatory.
- Fail if ok:true but marker absent. Fail if not_applied on this plain fixture.

## D2 — Optional hard case (only if human left x.com focused AND C+D passed)
Same unique marker style. not_applied on X is an honest hard-case gap — report Fail D2,
do not greenwash. Skip if still on the smoke fixture.

## E — Hygiene
Screenshot payloads stay path-only (no dataUrl). Paths under
`.tachyon/companion/screenshots/` re-read.

## Report format
| Gate | Pass/Fail | Evidence (path / url / 1-line) |
| A tool list + snapshot | | |
| B screenshot path + vision | | |
| C native fixture | | |
| D contenteditable fixture | | |
| D2 x.com optional | skip or result | |
| E no dataUrl leak | | |

If any Fail: short tool JSON snippets (no huge blobs).
If fixture A–E green: one line "fixture contour green" + screenshot path used for vision.
```

## Pass bar

| Gate | Green means |
|------|-------------|
| A | tools listable with tabTools on; snapshot works when paired |
| B / E | path contract (already shipped) |
| C / D fixture | type/fill land + verified |
| D2 | X composer; may stay red |

**Never greenwash:** `ok:true` without visible text is a product bug.
