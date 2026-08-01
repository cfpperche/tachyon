# agent-config-blast-radius — dogfood fixture

Exercises **t-588644**: one agent's refused profile must not take the whole roster down with it.

Before the fix, `loadProfileAwareConfig` treated any profile error as a broken FILE. Two agents, one
with a reference left stale by a plugin update, and the healthy one — which produced no error at all
— did not load either: `config` was undefined and the workspace had no agents. `agentNativeConfigPolicy.ts`
had already named the hazard in another context ("a refused profile is not a refused agent"); a
plugin update walks into it with no lane out.

The refusal itself is correct and must stay loud. What changed is its blast radius, and that the
surviving agents keep working while the banner names the one that did not.

| agent | authorizes | after the update |
| --- | --- | --- |
| `pinned` | `demo-drifty` | refused — its reference names bytes that are gone |
| `bystander` | `demo-stable` | must still load, with a pinned reference that stayed valid |

`bystander` authorizes a plugin on purpose. An agent that authorized nothing would survive for the
wrong reason — it would prove that agents with no references are safe, not that isolation is
per-agent.

## Run it

Arm from **the checkout whose VS Code window you will press F5 in** — `launch.json` reads
`${workspaceFolder}/.tachyon/dev-host`, so a window opened on a worktree uses that worktree's arm and
never the monorepo's. Arming the wrong one launches a stale fixture with no error anywhere:

```sh
cd <the checkout you have open>
npm run dogfood -- dev-host -- point --worktree <worktree> --fixture agent-config-blast-radius
npm run dogfood -- dev-host -- point-status   # "fixture source:" must name this fixture
```

Then F5 → **Tachyon: Dev Host**.

1. Create agent `bystander` in Agent Studio and authorize **demo-stable**.
2. Create agent `pinned` and authorize **demo-drifty**.
   Both plugins should read `Authorized`; both agents should be in the sidebar.
3. In the EDH's `shell` terminal: `./drift.sh`.
4. Reload the EDH window so the config is re-read from disk.

**Pass:**

- `bystander` is still in the roster and still spawnable.
- The durable config banner names **only** `pinned`, with `profile/digest-mismatch`.
- `pinned` is **in the roster too**, carrying a red `refused` badge whose tooltip is the reason, and
  it will not start. Its **Edit in Studio** action still opens — that is where the pin is repaired.

**Fail:** an empty roster (the blast radius is back), a banner that mentions `bystander` (the split
is leaking healthy agents into the failure list), or `pinned` missing from the roster entirely.

That last one was the shipped behaviour of 0.56.137 and is what **t-0ad300** fixed. Isolating the
refused agent meant deleting it from `config.agents`, which the legacy parser needs — and downstream
that made "refused" indistinguishable from "never declared". The agent disappeared from the sidebar,
from Fleet and from Control at once, and since Agent Studio opens from a roster row, the repair went
with it. A loud whole-roster failure had been traded for a quiet partial one, which t-588644 said in
its own body must not happen.

Step 4 matters. The isolation happens on the config load path, so an observation taken without a
reload is reading the roster from before the drift.

Do **not** reauthorize `pinned` here — the refused state is the subject. Repairing it is
`agent-capability-reauth`, the sibling fixture.

`drift.sh` refuses to run outside the dev-host mirror — mutating the tracked fixture would leave the
next run starting from a state nobody chose.
