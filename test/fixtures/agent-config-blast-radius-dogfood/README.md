# agent-config-blast-radius — dogfood fixture

Exercises **t-b0cfd4**: a plugin update must not invalidate the whole configuration. A pin whose
bytes moved withholds that one skill, names the repair, and leaves everything else running.

The fixture was built for **t-588644** (one agent's refused profile must not take the roster down)
and used a plugin update as its example of a refusal. t-b0cfd4 changed what that example *is*: a
stale pin no longer refuses the profile at all. The pin exists to keep bytes no human approved away
from an agent, and simply not delivering them satisfies that completely — refusing the rest of the
agent added no protection, and it destroyed the only repair path, because Agent Studio is where the
pin is re-approved. t-588644's isolation is unchanged and still guarded by unit tests, against a
failure that is genuinely fatal for one agent.

| agent | authorizes | after the update |
| --- | --- | --- |
| `pinned` | `demo-drifty` | still loads, **without** `demo-drifty` — the changed bytes are withheld |
| `bystander` | `demo-stable` | untouched: its pin did not move, so it keeps its skill |

`bystander` authorizes a plugin on purpose. An agent that authorized nothing would survive for the
wrong reason — it would prove that agents with no references are safe, not that the withholding is
per capability.

## Run it

Arm from **the checkout whose VS Code window you will press F5 in** — `launch.json` reads
`${workspaceFolder}/.tachyon/dev-host`, so a window opened on a worktree uses that worktree's arm and
never the monorepo's. Arming the wrong one launches a stale fixture with no error anywhere:

```sh
cd <the checkout you have open>
scripts/dev-host/cli.sh point --worktree <worktree> --fixture agent-config-blast-radius
scripts/dev-host/cli.sh point-status   # "fixture source:" must name this fixture
```

Then F5 → **Tachyon: Dev Host**.

1. Create agent `bystander` in Agent Studio and authorize **demo-stable**.
2. Create agent `pinned` and authorize **demo-drifty**.
   Both plugins should read `Authorized`; both agents should be in the sidebar.
3. In the EDH's `shell` terminal: `./drift.sh`.
4. Reload the EDH window so the config is re-read from disk.

**Pass:**

- Both agents are in the roster, spawnable, with **no** `config invalid` badge and no durable
  config-failure banner.
- A warning names `demo-drifty` for `pinned`: which skill, the digest it was authorized at, the
  digest on disk, and **Reauthorize** as the gesture that accepts the new content.
- `pinned` starts, and starts **without** demo-drifty. `bystander` still has demo-stable.
- Agent Studio shows `demo-drifty@2.0.0 Reauthorize (authorized at 1.0.0)` on `pinned`.

**Fail:** an empty roster or an `Invalid tachyon.yml` banner (the blast radius is back), `pinned`
starting *with* the updated demo-drifty (unapproved bytes reached an agent), or a warning that
mentions `bystander` (the withholding is leaking past the capability it is about).

Step 4 matters. The withholding happens on the config load path, so an observation taken without a
reload is reading the roster from before the drift.

Re-authorizing stays a **human** act and is not automated by any of this — `reauthorize` has no
default, because it says "I know this content changed since I approved it". What t-b0cfd4 changed is
the cost of not having done it yet: one missing skill instead of a dead agent. Repairing it is
`agent-capability-reauth`, the sibling fixture.

`drift.sh` refuses to run outside the dev-host mirror — mutating the tracked fixture would leave the
next run starting from a state nobody chose.
