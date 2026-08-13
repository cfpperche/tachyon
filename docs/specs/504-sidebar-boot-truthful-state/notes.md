# 504 — truthful sidebar boot state — notes

_Created 2026-08-13._

## Measurement record

- Configured live reload, UTC: activate `20:27:52.959`; engine PID start `20:27:54.140`;
  engine log installed `20:27:55.025`; config LKG `20:27:55.233`; startup GC completed
  `20:27:55.601`; control socket `20:27:55.613`; eager extensions complete `20:27:55.834`.
- Other configured live activation totals in the same host log: 1.666 s and 3.479 s.
- Genuine absent window: view-triggered activation at `15:53:46.798Z`; no engine/config/Bridge
  startup followed. Source inspection after the observation identifies the existing synchronous
  `hasConfig` discovery boundary that makes absence definitive.
- A new reload attempt was refused by governed host policy because `claude` and `toolinv` were both
  working. No active turn was disrupted to manufacture another sample.

## Decision

The measured run does not expose one dominant removable wait. Design the truthful state contract;
leave startup optimization to a later task only if a broader sample finds a repeatable dominant phase.
