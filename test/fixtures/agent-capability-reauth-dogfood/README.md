# agent-capability-reauth — dogfood fixture

Exercises **t-4a2a6f**: the Agent Studio's capability selectors must distinguish three states —
`Authorize` (never granted), `Reauthorize` (granted, but the tree changed since), `Authorized`
(granted and current) — instead of offering the same button for all three. Before the fix, a plugin
update left the pin naming bytes that no longer existed and the only control on offer was the one
the core refuses in silence; the failure surfaced as a `profile/digest-mismatch` at spawn, far from
the update that caused it.

Two plugins, installed as a directory install (no `source`/`integrity` in the lock — a dir install
legitimately has neither):

| plugin | role |
| --- | --- |
| `demo-stable` | the control — never changes, must stay `Authorized` |
| `demo-drifty` | the subject — `./drift.sh` updates it, must become `Reauthorize` |

## Run it

```sh
npm run dogfood -- dev-host -- point --worktree <worktree> --fixture agent-capability-reauth
```

Then F5 → **Tachyon: Dev Host** from the checkout that owns the dev-host.

1. Create an agent in Agent Studio (the roster starts empty on purpose).
2. Authorize both plugins → both read **Authorized**.
3. In the EDH's `shell` terminal: `./drift.sh` — same paths, new bytes, lock version `1.0.0` → `2.0.0`.
4. Reopen the Studio.

**Pass:** `demo-drifty` reads **Reauthorize** with `authorized at 1.0.0, now 2.0.0`, and
`demo-stable` still reads **Authorized**. A `Reauthorize` on `demo-stable` is a false positive in
the drift detector, which is the whole reason the control is here.

`drift.sh` refuses to run outside the dev-host mirror — mutating the tracked fixture would leave the
next run starting from a state nobody chose.
