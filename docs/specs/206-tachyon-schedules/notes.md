# 206 — tachyon-schedules — notes

## Design decisions

### 2026-06-11 — parent — at-schedules don't fire missed times unless catchUp
activate() suppresses an at-time already past at startup (marks the day done) so a
workspace opened at 14:00 doesn't retroactively fire a noon schedule; catchUp opts
back in. tick() only fires an at-time when the clock CROSSES it while open.

### 2026-06-11 — parent — approval writes to tachyon.yml
A pending proposal lives in .tachyon/ (inert). Approving converts it to a real
schedules: entry via the comment-preserving editor — durable, committable, the
single source of truth for what runs. Rejecting just drops the pending file entry.

## Deviations
## Tradeoffs
## Open questions
