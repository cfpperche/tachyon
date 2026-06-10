/**
 * Standalone Bridge host for the real-runtime E2E (spec scenario 3): boots the real
 * Bridge + AgentManager + TmuxService (real tmux, dedicated socket) outside VSCode so a
 * real agent CLI (e.g. `claude -p --mcp-config ...`) can drive the 7 tools end-to-end.
 * Prints the Bridge URL on stdout; runs until killed.
 */
import { Bridge } from "../../src/bridge/Bridge.js";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { PinStore } from "../../src/pins/PinStore.js";
import { AttentionMonitor } from "../../src/attention/AttentionMonitor.js";
import { LifecycleMonitor } from "../../src/agents/LifecycleMonitor.js";
import { Waiters } from "../../src/bridge/Waiters.js";
import { ControlModeClient } from "../../src/tmux/ControlModeClient.js";
import { CMD_WAIT_PREFIX } from "../../src/bridge/tools.js";
import { CommandRunner } from "../../src/commands/CommandRunner.js";
import { RunbookRunner } from "../../src/commands/RunbookRunner.js";
import { subtreeCpuTicks } from "../../src/attention/cpu.js";

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
  getMaxAgents: () => 3,
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

const bridge = new Bridge(
  {
    manager,
    tmux,
    pins: new PinStore(workspaceRoot),
    notify: (message, level) => console.error(`NOTIFY[${level}]: ${message}`),
    attentionOf: (agent) => monitor.stateOf(agent)?.state,
    waiters,
    commands,
    runbooks,
  },
  { token },
);

bridge.start().then(() => {
  console.log(`BRIDGE_URL=${bridge.url}`);
  console.error(`workspace hash: ${workspaceHash(workspaceRoot)}; auth: ${token ? "ON" : "off"}`);
});
