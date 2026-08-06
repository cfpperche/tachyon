# Measurement — 2026-08-06

This file records what the machine did. It was written before the spec was designed.
Every claim below names the door that produced it.

The task `t-f353bc` predicted one outcome. The measurement refuted four of its premises.
All four are recorded here. They change the design, so they are stated first.

---

## Refutation 1 — the roster is NOT versioned

The task predicted: "if the roster is versioned and the authority is local to the machine,
then a fresh clone receives roster entries with no authority."

The premise is false. `tachyon.yml` is ignored by Git.

```
$ git check-ignore -v tachyon.yml
.gitignore:32:tachyon.yml    tachyon.yml
```

A fresh clone was made and inspected.

```
$ git clone /home/goat/tachyon <scratch>/clone
$ ls <scratch>/clone/tachyon.yml
ls: cannot access '.../clone/tachyon.yml': No such file or directory
$ ls <scratch>/clone/.tachyon/agents
ls: cannot access '.../clone/.tachyon/agents': No such file or directory
```

The clone has no roster and no profiles. It has `.tachyon/designs`, `.tachyon/evidence`,
`.tachyon/reviews` and `.tachyon/studies` only.

The prediction cannot be tested by cloning. The roster does not travel through Git.
The roster travels by COPY. Three copy channels exist today:

1. `tachyon.yml.example`, shipped in the repository;
2. `~/.local/share/tachyon-backups/tachyon.yml.latest`, named in `.gitignore`;
3. any move or rename of the checkout directory.

Channel 3 matters most. `workspaceHash` is derived from the path
(`src/tmux/TmuxService.ts:330`):

```ts
return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 8);
```

The authority lives under `agentProfileAuthoritiesSecretKey(wsHash)`. A renamed directory
therefore produces a new key. The authority is not lost. The authority becomes unreachable.

**The owner's decision is correct, but for a different reason than the task gave.** The
roster is already machine-local. It is not shared through Git today. Moving it out of
`tachyon.yml` does not make it local. Moving it out separates two documents that are already
owned by different people.

---

## Refutation 2 — the documented onboarding path does not load

The real loader `loadProfileAwareConfig` was run against the clone. The probe is
`evidence/probe.ts`. It supplies an empty authority map, which is what the extension host
reads at a path whose secret key was never written.

The clone was prepared by the path `tachyon.yml.example` documents:

```
# Live config is gitignored. Create/edit locally:
#   cp tachyon.yml.example tachyon.yml
```

Result:

```
config loaded: no
errors: [
  "agents.hermes: inline agent definitions are no longer supported; create or edit the
   canonical agent in Agent Studio"
]
```

The config does not load. It does not load partially. `config` is `undefined`.

`tachyon.yml.example` declares `hermes: { cmd: hermes }`. That inline form was retired.
The backup at `~/.local/share/tachyon-backups/tachyon.yml.latest` has the same defect. It
declares `hermes` and `pi`, both inline.

Both documented copy channels are broken. This is a separate defect and belongs in its own
task. It is recorded here because it is the reason no one has met Refutation 3 yet.

---

## Refutation 3 — the failure is worse than "every agent is born refused"

The live roster and the live profiles were copied to the clone. The path differs, so the
authority map is empty.

```
$ cp /home/goat/tachyon/tachyon.yml <scratch>/clone/
$ cp -r /home/goat/tachyon/.tachyon/agents/. <scratch>/clone/.tachyon/agents/
$ node probe.cjs <scratch>/clone
config loaded: no
errors: [
  "agents.claude.profile: host profile authority is missing",
  "agents.claude-cowntdown.profile: host profile authority is missing",
  "agents.claude23.profile: host profile authority is missing"
]
```

The refusal reason is the predicted one. The consequence is not.

`config` is `undefined`. The whole file failed. `agentProfileConfigLoader.ts:174` returns
early when `projected.size === 0`:

```ts
if (errors.length > profileErrors.length || (errors.length > 0 && projected.size === 0)) {
  return { errors, warnings: [], profileErrors };
}
```

Per-agent isolation saves a healthy remainder. There is no healthy remainder when every
agent lost its authority at once. The workspace therefore loses `settings` as well:
`verify`, `projectGuidance`, `maxAgents` and `auth` all fall with the fleet.

**A copied roster does not degrade the fleet. It takes the workspace down.**

---

## Refutation 4 — `claude23` is not refused for the reason the task states

The task states that `claude23` is born `refused` because the authority is missing.
The live product says otherwise. Measured through `list_agents`, the Bridge door:

```json
{
  "name": "claude23",
  "refused": "profile: profile/native-config-value: Claude global key
    'permissions.defaultMode' value 'bypassPermissions' is not projectable
    (supported: acceptEdits, auto, manual, dontAsk, plan); authorize it explicitly for this
    agent, set the Permissions family to Exclude, or change the global value"
}
```

The loader checks the authority first (`agentProfileConfigLoader.ts:140-144`):

```ts
const authority = input.authorities.get(agentName);
if (!authority) {
  refuse(agentName, pointer.path, ".profile: host profile authority is missing");
  continue;
}
```

`claude23` reached `projectCanonicalAgentProfile` and failed there. Therefore `claude23`
HAS an authority record. All three places agree that `claude23` exists.

The real cause is a FOURTH place, which the task did not list:

```
$ cat ~/.claude/settings.json
"permissions": { "defaultMode": "bypassPermissions", ... }
```

`~/.claude/settings.json` belongs to the Claude runtime and to the host machine. Any tool
may write it. `claude23` selects the permissions family from `global` and declares no
`authorize` list. `claude` works only because its profile declares
`authorize: [bypassPermissions]`.

**The refusal is correct behaviour.** Spec `471-claude-bypass-permissions-optin` is shipped
and specified exactly this refusal. Inheritance alone must never grant `bypassPermissions`.

`claude23` is not a broken agent. `claude23` is a correctly refused agent.

---

## The real defect — refusal and removability share one map

The reproduction is `evidence/repro.ts`. It builds two Claude agents in a scratch workspace
with a private fake home. Both select the permissions family from `global`. One declares
`authorize: [bypassPermissions]`. The other does not. Both hold valid authority records.

```
config loaded:       yes
config.agents keys:  ["good"]
agentSources:
  good: mode=profile
  bad:  mode=refused
        reason: profile: profile/native-config-value: Claude global key
                'permissions.defaultMode' value 'bypassPermissions' is not projectable ...
```

The refusal string is byte-identical to the one `list_agents` reports for `claude23`.

The loader deletes every non-projected agent from the document
(`agentProfileConfigLoader.ts:180-182`), so a refused agent is absent from `config.agents`.
`agentSources` keeps the name. `config.agents` does not.

Every removal door reads `config.agents`:

```
--- isAgentProfileAgent(name) = asAgent(config.agents[name])?.profileLifecycle !== undefined
  good: true
  bad:  false
```

| Actor | Door | Reads | Outcome for a refused agent |
|---|---|---|---|
| Human, Agent Studio | `planAgentProfileForget` (`Workspace.ts:4125`) | `isAgentProfileAgent` | throws |
| Human, Agent Studio | `forgetAgentProfileAgentCascade` (`Workspace.ts:4195`) | `isAgentProfileAgent` | throws |
| Agent, Bridge | `propose_saved_agent_removal` -> `inspectSavedAgentProfile` (`Workspace.ts:2099`) | `isAgentProfileAgent` | `undefined` |
| Agent or Human | `dismiss_agent` | `lifetime === "saved"` | refused by name |
| Human, text editor | edit `tachyon.yml` | nothing | succeeds, and orphans the rest |

`planForget` (`agentStudioDomain.ts:166-177`) catches the throw and posts an error message.
It never posts a plan result. `ForgetPlanView.tsx:55` renders the pending state while
`result` is `undefined`:

```tsx
if (!result) return <div class="ash-forget-plan-pending">Computing what this will do…</div>;
```

**This is the complete cause of `t-02e72c`.** The dialogue never leaves "Computing what this
will do…" because the plan is never computed and the refusal arrives on another channel.

The last row of the table is the only door that works today. It is the door with no
transaction, no journal and no reconciliation. That is consistent with the measurement:
`.tachyon/canonical-agent-transactions/locks/` and `lifecycle/` hold zero entries, and no
`forget/*/journal.json` names `claude23`. The transaction did not fail. The transaction was
never reached.

## A trap for whoever fixes this

`planAgentProfileForget` computes the `tachyon.yml` step from the same broken map
(`Workspace.ts:4170`):

```ts
locatorPresent: this.config?.agents[name] !== undefined,
```

Measured in the reproduction:

```
  bad: locatorPresent=false  (tachyon.yml actually declares it: true)
```

A naive fix removes the `isAgentProfileAgent` guard. The plan then computes, reports
"already satisfied" for `remove-locator`, and leaves the `tachyon.yml` row on disk. The agent
stays in the roster and comes back on the next load.

## Fleet inventory, measured

The task names four agents. Three exist.

```
$ ls /home/goat/tachyon/.tachyon/agents/
claude  claude-cowntdown  claude23
```

`tachyon.yml` declares the same three. `claude-prosa` exists in neither. `list_agents` also
shows `statehome`, which is a Temporary agent and holds no roster row.

## Reproduction commands

```
node_modules/.bin/esbuild probe.ts --bundle --platform=node --format=cjs --outfile=probe.cjs
node probe.cjs <workspace-root>

node_modules/.bin/esbuild repro.ts --bundle --platform=node --format=cjs --outfile=repro.cjs
node repro.cjs <scratch-workspace> <scratch-home>
```

`claude23` was NOT deleted. It stays as the live reproduction of `t-02e72c`.
