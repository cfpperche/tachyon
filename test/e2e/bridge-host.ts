/**
 * Standalone Bridge host for the real-runtime E2E (spec scenario 3): boots the real
 * Bridge + AgentManager + TmuxService (real tmux, dedicated socket) outside VSCode so a
 * real agent CLI (e.g. `claude -p --mcp-config ...`) can drive the 7 tools end-to-end.
 * Prints the Bridge URL on stdout; runs until killed.
 */
// Keep workspace imports relative: delegated worktrees share the primary checkout's node_modules,
// so package-name imports can resolve a different tree and split TypeScript private-class identities.
import { Bridge } from "../../packages/engine/src/bridge/Bridge.js";
import { AgentManager } from "../../packages/engine/src/agents/AgentManager.js";
import { TmuxService, workspaceHash } from "../../packages/engine/src/tmux/TmuxService.js";
import { parseConfig } from "../../packages/engine/src/config/loadConfig.js";
import { PinStore } from "../../packages/engine/src/pins/PinStore.js";
import { TaskStore } from "../../packages/engine/src/tasks/TaskStore.js";
import { ValidationStore } from "../../packages/engine/src/validations/ValidationStore.js";
import { AttentionMonitor } from "../../packages/shared/src/attention/AttentionMonitor.js";
import { LifecycleMonitor } from "../../packages/engine/src/agents/LifecycleMonitor.js";
import { CMD_WAIT_PREFIX, Waiters } from "../../packages/engine/src/workspace/Waiters.js";
import { ControlModeClient } from "../../packages/engine/src/tmux/ControlModeClient.js";
import { CommandRunner } from "../../packages/engine/src/commands/CommandRunner.js";
import { Scheduler } from "../../packages/engine/src/schedule/Scheduler.js";
import { ProposalStore } from "../../packages/engine/src/schedule/ProposalStore.js";
import { RunbookRunner } from "../../packages/engine/src/commands/RunbookRunner.js";
import { subtreeCpuTicks } from "../../packages/engine/src/attention/cpu.js";

const workspaceRoot = process.env.TACHYON_E2E_ROOT ?? "/tmp/tachyon-e2e";
const { config, errors } = parseConfig(
  [
    "agents:",
    "  probe:",
    "    cmd: sh",
    "commands:",
    "  hello:",
    "    cmd: echo e2e-hello",
    "  failer:",
    "    cmd: \"sh -c 'echo doomed; exit 7'\"",
    "runbooks:",
    "  ship:",
    "    steps: [hello, \"echo inline-step\"]",
    "settings:",
    "  maxAgents: 3",
    "",
  ].join("\n"),
);
if (!config) throw new Error(errors.join("; "));

const tmux = new TmuxService();
const manager = new AgentManager({
  tmux,
  wsHash: workspaceHash(workspaceRoot),
  workspaceRoot,
  getConfig: () => config,
});

const token = process.env.TACHYON_E2E_TOKEN;

const waiters = new Waiters();
const monitor = new AttentionMonitor(
  {
    runningAgents: () => manager.runningAgents(),
    capturePane: (agent) => tmux.capturePane(manager.session(agent)),
    cpuTicks: async (agent) => {
      try {
        return subtreeCpuTicks(await tmux.panePid(manager.session(agent)));
      } catch {
        return null;
      }
    },
    settingsOf: () => ({ enabled: true, silenceSec: 5, patterns: [] }),
    now: () => Date.now(),
  },
  (agent, attention) => waiters.notifyAttention(agent, attention.state),
);
const lifecycle = new LifecycleMonitor(
  {
    agentStates: () => manager.agentStates(),
    policyOf: () => "never",
    scheduleRestart: () => {},
    now: () => Date.now(),
  },
  {
    onCrash: (agent, exitCode) => waiters.notifyDead(agent, exitCode),
    onCleanExit: (agent) => waiters.notifyDead(agent, 0),
    onGone: (agent) => waiters.notifyGone(agent),
  },
);
const wsHash = workspaceHash(workspaceRoot);
const commands = new CommandRunner({
  tmux,
  wsHash,
  workspaceRoot,
  getConfig: () => config,
  onFinished: (name, exitCode) => waiters.notifyDead(`${CMD_WAIT_PREFIX}${name}`, exitCode),
});
const runbooks = new RunbookRunner({
  tmux,
  wsHash,
  workspaceRoot,
  getConfig: () => config,
});

// F20 engine: command channel + event-driven lifecycle (ticker stays as heartbeat).
const engine = new ControlModeClient({
  wsHash,
  onDeadMapChanged: () => {
    void lifecycle.tick();
    void commands.tick();
  },
  onSessionsChanged: () => void lifecycle.tick(),
  onStateChange: (isUp) => console.error(`engine: ${isUp ? "up" : "down (subprocess fallback)"}`),
});
tmux.useExecutor(engine.makeExecutor());
void engine.start();

setInterval(() => {
  void lifecycle.tick();
  void monitor.tick();
  void commands.tick();
}, 1000);

const scheduler = new Scheduler({ getConfig: () => config, onFire: () => {} });
const proposals = new ProposalStore(workspaceRoot);

const bridge = new Bridge(
  {
    workspaceRoot,
    manager,
    tmux,
    pins: new PinStore(workspaceRoot),
    tasks: new TaskStore(workspaceRoot),
    validations: new ValidationStore(workspaceRoot),
    notify: (message, level) => console.error(`NOTIFY[${level}]: ${message}`),
    attentionOf: (agent) => monitor.stateOf(agent)?.state,
    waiters,
    commands,
    runbooks,
    scheduler,
    proposals,
    onScheduleProposed: ({ name, by }) => console.error(`PROPOSED: ${name} by ${by}`),
  },
  { token },
);

bridge.start().then(() => {
  console.log(`BRIDGE_URL=${bridge.url}`);
  console.error(`workspace hash: ${workspaceHash(workspaceRoot)}; auth: ${token ? "ON" : "off"}`);
});
