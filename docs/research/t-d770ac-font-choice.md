# t-d770ac — font choice measurements

Measured 2026-08-18 in Chrome 151 (`HeadlessChrome/151.0.0.0`) before any design. Method for `ch`:
the same canvas `measureText("0" × 100) / 100` used by SDD 513 fatia 0
(`scripts/research/t-7eb2e4-diff-load.mjs`). Faces were `document.fonts.load`'d over HTTP;
a first file:// pass left both faces `unloaded` and was discarded.

## 1. License

Departure Mono **v1.500**, Helena Zhang, **SIL Open Font License 1.1**.
Source: `https://github.com/rektdeckard/departure-mono` `public/assets/LICENSE`.
No Reserved Font Name after the copyright line. OFL §2 allows bundling/embedding with software
when the copyright + OFL travel with the files. Same license as the already-shipped Tachyon Mono
(JetBrains Mono 2.304). VSIX redistribution is allowed.

`DepartureMono-Regular.woff2` SHA-256
`5b4fed1daa90708aa9c6ee1190abca9dc22164a1c1def0020386e46b61038cfb`.

## 2. Package weight

Upstream ships **one Regular face**. There is no Medium / SemiBold / Bold file.

| file | bytes |
|---|---:|
| DepartureMono-Regular.woff2 | 22,496 |
| JetBrainsMono-Regular.woff2 | 92,164 |
| JetBrainsMono 4 weights (today) | 375,048 |

UI CSS uses 500/600/700. Those synthesize from Regular. Chrome 151: synthetic 600 does **not**
change advance width. README says pixel-perfect only at 11px increments — host scale is unchanged.

## 3. Metric

Unified columns = `floor((880 − 96) / ch)`. Split = `floor(((880 − 168) / 2) / ch)`.

| face | 12px canvas `0` | unified / split | line-height:normal |
|---|---:|---|---:|
| generic `monospace` | 7.224609375 | **108 / 49** | 14 |
| Tachyon Mono | 7.200057983 | **108 / 49** | 16 |
| Departure Mono | 7.636352539 | **102 / 46** | 15 |

At 13px (`--ds-body` / host `--vscode-font-size`): Tachyon 7.800 → 100 cols, lh 17px;
Departure 8.273 → 94 cols, lh 17px.

The 108-column number was computed on generic `12px monospace`. Tachyon Mono happens to floor to
the same 108. Departure changes it. Unified-vs-side-by-side still holds (side-by-side gets worse).
This card does not retune 108. Agent Pane stays excluded: Departure is the more unusual metric.

## 4. Where the choice lives

The brief named two doors. A third already exists and is the one that fits.

- `contributes.configuration` is retired and locked (`t-aaad95`,
  `test/unit/settingsAuthorityInventory.test.ts`). Reopening it is a boundary regression.
- `tachyon.yml` is workspace-versioned and team-shared. Font is a personal preference.
- `~/.tachyon/settings.json` already stores per-person per-machine values
  (`activity.codeTheme`, `agentPane.enabled`, `gitPath`).

**Decision:** `font.mono` = `"tachyon"` | `"departure"` in the global document. Default `"tachyon"`.

Reload: Settings applies immediately via `data-tachyon-font`. Other surfaces apply the next time
they are opened. Not a VS Code window reload.
