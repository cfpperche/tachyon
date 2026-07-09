# t-bae005 Design: Task Mutation Notifications

## Scope

Design only. No product code changes in this task.

Add settings-gated VS Code toasts for agent task create/edit events, with hybrid configuration:

1. VS Code preferences for human UX and per-user/per-workspace overrides.
2. Optional `tachyon.yml` defaults for teams that want shared behavior.
3. Effective precedence: user VS Code > workspace VS Code > `tachyon.yml` > hardcoded defaults.

The implementation should preserve the existing agent-to-agent assignee pane notice from `t-ea86e6` and add human-facing VS Code toasts as a separate notification class.

## Existing Surfaces

- `package.json` already contributes `tachyon.*` settings under `contributes.configuration`.
- `src/workspace/EngineHost.ts` exposes `getSetting(section, key, dflt)` and `notify(message, level, actions)`.
- `src/workspace/VsCodeHost.ts` maps `getSetting` to `vscode.workspace.getConfiguration(section).get(key, dflt)` and `notify` to `NotificationService`.
- `src/config/loadConfig.ts` parses `settings:` from `tachyon.yml` and rejects unknown keys.
- `src/workspace/Workspace.ts` wires Bridge dependencies and currently refreshes task views through `onTasksChanged`.
- `src/bridge/tools.ts` is the Bridge mutation choke point for `create_task`, `update_task`, `flag_for_human`, `clear_human_flag`, and `append_task_note`.
- `src/tasks/TaskStore.ts` owns persisted task state, validation, CAS, and journal storage; it should stay UI-free.
- `t-ea86e6` already added `notifyTaskAssignee` in `src/bridge/tools.ts`, sending an in-pane notice when `update_task` changes `assignee` to a live agent, with self-assign suppression and best-effort failure handling.

## Actors

- **Human in VS Code**: recipient of editor toasts. Their VS Code preferences always win.
- **Agent caller**: Bridge-authenticated agent creating/updating/flagging/journaling tasks.
- **Human/external/master caller**: possible Bridge callers for some task operations, depending on current tool rules.
- **Task assignee agent**: recipient of the existing pane notice when assigned to a task.
- **Workspace/team**: can set team defaults in `tachyon.yml`.
- **Host shell**: VS Code implements settings and notifications; headless hosts can no-op or test-record.

## Proposed Settings

### VS Code contributed settings

Add these under `contributes.configuration.properties`:

- `tachyon.taskNotifications.enabled`
  - Type: `boolean`
  - Default: `true`
  - Description: Show VS Code notifications for task create/edit events.
- `tachyon.taskNotifications.events`
  - Type: `array`
  - Default: `["created", "assignedToMe", "assignedToOther", "statusChanged", "awaitingHuman", "journalAppended"]` (all on — maintainer will quiet via settings after dogfood pain)
  - Enum items:
    - `created`
    - `assignedToMe`
    - `assignedToOther`
    - `statusChanged`
    - `awaitingHuman`
    - `journalAppended`
  - Description: Task events that can show VS Code notifications.
- `tachyon.taskNotifications.suppressOwnChanges`
  - Type: `boolean`
  - Default: `true`
  - Description: Do not show a VS Code notification when the current caller is also the relevant recipient/actor.
- `tachyon.taskNotifications.dedupeWindowMs`
  - Type: `number`
  - Default: `30000`
  - Minimum: `0`
  - Description: Suppress identical task notifications within this window.

Use plain text strings in `package.nls*.json` if this repo keeps contributed setting descriptions localized.

### `tachyon.yml` defaults

Add optional shared defaults:

```yaml
settings:
  taskNotifications:
    enabled: true
    events:
      - created
      - assignedToMe
      - assignedToOther
      - statusChanged
      - awaitingHuman
      - journalAppended
    suppressOwnChanges: true
    dedupeWindowMs: 30000
```

Schema/parse rules:

- `enabled`: boolean.
- `events`: non-empty list of known event ids. Empty list is allowed only if the intended meaning is "enabled but no events"; simpler implementation can reject empty and tell users to set `enabled: false`.
- `suppressOwnChanges`: boolean.
- `dedupeWindowMs`: integer `>= 0`.
- Unknown keys under `settings.taskNotifications` should be rejected, matching existing settings validation style.

### Merge Semantics

Implementation should expose a pure resolver, for example:

```ts
resolveTaskNotificationSettings({
  vscodeUser,
  vscodeWorkspace,
  yml,
  defaults,
})
```

Effective precedence is per key:

1. VS Code user setting.
2. VS Code workspace setting.
3. `tachyon.yml` `settings.taskNotifications`.
4. Hardcoded defaults.

Important implementation note: `EngineHost.getSetting(section, key, dflt)` returns the already-effective VS Code value, not the inspectable per-scope values. To honor "user VS Code > workspace VS Code > yml", the VS Code host needs a small inspect-capable settings method, or a helper local to `VsCodeHost`, for this setting family. Do not use `get("taskNotifications.enabled", ymlDefault)` blindly: that would make VS Code's contributed default mask `tachyon.yml`.

Recommended host addition:

```ts
getSettingInspect?<T>(section: string, key: string): {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
};
```

For non-VS Code/headless hosts, absence of `getSettingInspect` means "no VS Code override"; the resolver uses yml/defaults.

## Event Matrix

| Event id | Trigger | Recipient | Default | Toast |
|---|---|---|---|---|
| `created` | `create_task` succeeds | Human | **On** | `Task created: <title>` |
| `assignedToMe` | `update_task` changes `assignee` to a known live or declared agent that maps to the current human's observed fleet | Human | **On** | `Task assigned to <agent>: <title>` |
| `assignedToOther` | `update_task` changes `assignee` to another agent | Human | **On** | `Task assigned to <agent>: <title>` |
| `statusChanged` | `update_task` changes `status` | Human | **On** | `Task <id> moved to <status>: <title>` |
| `awaitingHuman` | `flag_for_human` succeeds | Human | **On** | `Task needs you: <title>` |
| `journalAppended` | `append_task_note` succeeds on an active task | Human | **On** | `Task note added: <title>` |

**Maintainer decision (2026-07-09):** all events **on** by default. Prefer dogfood noise and dial down via VS Code / yml settings as real pain appears — do not pre-optimize for quiet.

## Toast Copy And Actions

Keep copy short and factual:

- `Task created: <title>`
- `Task assigned to <agent>: <title>`
- `Task <id> moved to <status>: <title>`
- `Task needs you: <title>`
- `Task note added: <title>`

Actions:

- `Open`: open the Task Detail or Mission Control focused on the task. If direct task focus is not available yet, focus the primary Tachyon view as the first implementation step.
- No `Dismiss` action; VS Code supplies dismissal.

Levels:

- `info` for normal task changes.
- `warn` for `awaitingHuman`, because it is explicitly blocked on human input.
- Never `error`; task mutation success is not an error state.

Title truncation:

- Cap displayed title to about 120 characters in the notification helper. Do not mutate persisted task title.

## Choke Point

Add a single policy/helper module near the Bridge or workspace boundary, for example:

- `src/tasks/taskNotificationPolicy.ts` for pure event classification/settings/dedupe keys.
- `src/workspace/TaskNotificationService.ts` for host-backed toast delivery.

The Bridge handlers in `src/bridge/tools.ts` should emit an internal event after successful mutation, alongside the existing `onTasksChanged` calls. Do not put toast logic into `TaskStore`; it must remain persistence/validation only.

Suggested dependency extension:

```ts
onTaskNotificationEvent?: (event: TaskNotificationEvent) => void;
```

Event shape:

```ts
type TaskNotificationEvent =
  | { type: "created"; task: Task; actor: string }
  | { type: "assigned"; task: Task; actor: string; from?: string; to: string }
  | { type: "statusChanged"; task: Task; actor: string; from: TaskStatus; to: TaskStatus }
  | { type: "awaitingHuman"; task: Task; actor: string; reason: string; kind: string }
  | { type: "journalAppended"; task: Task; actor: string };
```

`src/workspace/Workspace.ts` should own converting this event into a VS Code toast because it has the host, terminals/view actions, parsed config, and settings access.

Keep `notifyTaskAssignee` separate:

- It is an agent pane delivery.
- It targets the assignee agent, not the human.
- It uses `deliverNotice`/tmux delivery and queueing semantics.
- It already suppresses self-assignment from agent callers.

## Deduplication

Dedup in the host-backed notification service, not in Bridge handlers.

Key:

```text
<workspaceRoot>|<eventType>|<taskId>|<recipientOrAssignee>|<meaningfulValue>
```

Examples:

- Assignment: `root|assigned|t-abc123|codex`
- Status: `root|statusChanged|t-abc123|active`
- Awaiting human: `root|awaitingHuman|t-abc123|<kind>|<reasonHash>`
- Journal: `root|journalAppended|t-abc123|<actor>`

Use an in-memory TTL map keyed by this string:

- Default TTL from effective `dedupeWindowMs`.
- `0` disables dedupe.
- Clean opportunistically on notify attempts.

This should suppress repeated Bridge retries or near-duplicate UI fan-out, but should not persist across extension reloads.

## Interaction With Current Assignee Notice

Current behavior in `update_task`:

- Reads prior assignee before mutation.
- Updates task.
- Refreshes task view.
- If new `assignee` differs and is not self-assignment, calls `notifyTaskAssignee`.

Future behavior:

1. Preserve all of the above.
2. Also emit a human-facing `assigned` notification event after successful mutation.
3. Let settings decide whether the human sees `assignedToMe`, `assignedToOther`, both, or neither.

Do not make task mutation fail if human toast delivery fails.

## Test Plan

Pure unit tests:

- Settings resolver precedence: user VS Code beats workspace VS Code, workspace beats yml, yml beats hardcoded defaults.
- VS Code contributed defaults do not mask yml defaults when the user/workspace did not explicitly set a value.
- Yaml parsing accepts valid `settings.taskNotifications`.
- Yaml parsing rejects unknown keys, bad event ids, non-boolean booleans, and negative/non-integer dedupe windows.
- Event classifier emits exactly one event for create, assignment change, status change, awaiting-human flag, and journal append.
- Event classifier emits no assignment event for reasserting the same assignee.
- Dedupe suppresses identical event keys inside the TTL and allows them after TTL.

Bridge/workspace unit tests:

- `create_task` emits a `created` event only after `TaskStore.create` succeeds.
- `update_task` emits assignment/status events only after `TaskStore.update` succeeds.
- Rejected `update_task` emits no notification event.
- Existing `t-ea86e6` agent-pane assignment tests still pass unchanged.
- `append_task_note` emits `journalAppended` after journal append and still notifies active task assignee per current behavior.
- `flag_for_human` emits `awaitingHuman`; `clear_human_flag` should not toast by default.

Host tests:

- Workspace wires events to `host.notify` only when effective settings allow the event.
- `Open` action focuses Mission Control or the task detail path chosen for implementation.
- Terminal-active suppression is not reused for task mutation notifications; these are task-board events, not live prompt prompts.

Verify:

- `npm run typecheck`
- `npm run verify:full`

## Phased Implementation Tasks

1. Add the pure settings resolver and task notification policy types/tests.
2. Add `tachyon.taskNotifications.*` contributed settings and nls strings.
3. Extend `loadConfig.ts` and `tachyon.schema.json` for `settings.taskNotifications`.
4. Add an inspect-capable VS Code settings path so explicit VS Code scopes can override yml without contributed defaults masking yml.
5. Add Bridge `onTaskNotificationEvent` emission after successful task mutations.
6. Add workspace notification service with dedupe, copy, levels, and `Open` action.
7. Run focused tests, then `npm run typecheck` and `npm run verify:full`.

## Open Questions

1. Should `assignedToMe` mean "assigned to any live/declared agent" for the human observer, or only "assigned to an agent whose terminal is currently visible/running in this workspace"?
2. ~~Should `created` remain off by default?~~ **Resolved:** all events including `created` default **on** (maintainer dogfood-first).
3. Should `clear_human_flag` ever show a positive "unblocked" toast, or stay silent to avoid churn?
