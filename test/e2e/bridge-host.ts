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

const workspaceRoot = process.env.TACHYON_E2E_ROOT ?? "/tmp/tachyon-e2e";
const { config, errors } = parseConfig(
  ["agents:", "  probe:", "    cmd: sh", "settings:", "  maxAgents: 3", ""].join("\n"),
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

const bridge = new Bridge(
  {
    manager,
    tmux,
    pins: new PinStore(workspaceRoot),
    notify: (message, level) => console.error(`NOTIFY[${level}]: ${message}`),
  },
  { token },
);

bridge.start().then(() => {
  console.log(`BRIDGE_URL=${bridge.url}`);
  console.error(`workspace hash: ${workspaceHash(workspaceRoot)}; auth: ${token ? "ON" : "off"}`);
});
