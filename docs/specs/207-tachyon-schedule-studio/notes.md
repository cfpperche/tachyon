# 207 — tachyon-schedule-studio — notes

## Design decisions
### 2026-06-11 — parent — text target, not a dropdown
The schedule's run/spawn target is a text input + hint (not a populated dropdown). Keeps the webview simple; a bad reference fails on config reload with a clear parse error. Revisit if it trips people.

## Deviations
## Tradeoffs
## Open questions
