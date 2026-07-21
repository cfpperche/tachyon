# Dogfood — Companion first-person (multi-runtime)

**Ship note:** screenshot → workspace path + vision (`user_browser_screenshot` → path under
`.tachyon/companion/screenshots/` + runtime file/image read) is **done**. Do not re-open re-encode
unless vision regresses.

This run validates **actuation honesty + leaf insert**, not only capture.

## Pre-flight (human)

1. EDH: **Tachyon: Dev Host** F5 (companion-track pointer).
2. Chrome extension **≥ 0.4.4** (Load unpacked release folder).
3. Pair Companion + Agent tab access ON.
4. Open the smoke fixture in the **active** tab:
   - Prefer:
     `…/test/fixtures/companion-track-dogfood/actuation-smoke.html`
     (file:// or static server).
   - Optional hard case after green on fixture: x.com composer.

## Prompt (any Bridge agent: Grok / Claude / Codex / …)

```
# Mission: validate Companion actuation honesty + screenshot path

Use ONLY Companion tab tools (user_browser_*). No agent-browser/CDP. No eval-to-type.

Runtime-neutral reads: for image/path checks use read_file OR this runtime's equivalent
file/image read tool. Do not fail Gate B only because the tool is named differently.

## A — Pairing
1. Confirm user_browser_* tools exist.
2. user_browser_snapshot once; note url/title.

## B — Screenshot path (regression)
1. user_browser_screenshot.
2. Assert JSON: ok, kind=screenshot, path starts with `.tachyon/companion/screenshots/`,
   has url/title/mimeType/byteLength/format, NO dataUrl/base64 blob.
3. Read that path with the runtime's file/image tool and confirm first-person vision.

## C — Native field (fixture first)
On actuation-smoke.html (or any page with #native-input):
1. user_browser_fill selector `#native-input` value `tachyon-native-fill-smoke`.
2. Expect ok:true, verified:true (or detail showing method), visibleText includes marker.
3. Confirm via snapshot and/or screenshot vision.
If fill returns ok:false code not_applied → FAIL honesty is working but actuation broken.

## D — Contenteditable (fixture first)
1. user_browser_click `#rich-editor` if needed.
2. user_browser_type or fill `#rich-editor` with `tachyon-ce-dogfood-smoke`.
3. Expect ok:true only if marker is really in the editor (verified).
4. Confirm with screenshot vision OR snapshot text — if snapshot truncates, screenshot is mandatory.
Fail if ok:true but marker absent (honesty bug). Fail if not_applied on plain contenteditable fixture.

## D2 — Optional hard case (x.com)
Only after C+D pass on the fixture. Same marker uniqueness. Hard-case fail is product gap,
not a failed honesty contract if code is not_applied.

## E — Hygiene
No dataUrl in screenshot payloads. Paths re-readable under `.tachyon/companion/screenshots/`.

## Report
| Gate | Pass/Fail | Evidence |
| A | | |
| B | | |
| C native fixture | | |
| D contenteditable fixture | | |
| D2 x.com (optional) | | |
| E | | |
```

## Pass bar

| Gate | Green means |
|------|-------------|
| B / E | path contract (already shipped) |
| C / D fixture | type/fill land + verified |
| D2 | X composer; may stay red until leaf/MAIN work deepens |

**Never greenwash:** `ok:true` without visible text is a product bug.
