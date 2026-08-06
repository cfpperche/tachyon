/**
 * Reproduces the coupling t-02e72c rests on, with NO SecretStorage access:
 * a projection refusal deletes the agent from `config.agents`, and every removal
 * door reads `config.agents`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProfileAwareConfig } from "<workspace-root>/src/config/agentProfileConfigLoader.js";
import { CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR } from "<workspace-root>/src/config/agentProfileProjection.js";
import { asAgent } from "<workspace-root>/src/config/loadConfig.js";
import type { AgentProfileAuthorityRecord } from "<workspace-root>/src/config/agentProfileAuthority.js";

const root = process.argv[2]!;
const home = process.argv[3]!;

function profileYaml(agentId: string, authorize: boolean): string {
  return [
    "schemaVersion: 1",
    `agentId: ${agentId}`,
    "runtime:",
    "  adapter: claude",
    "  executable: claude",
    "lifecycle:",
    "  enabled: true",
    "nativeConfig:",
    "  permissions:",
    "    source: global",
    "    treatment: overlay",
    "    refresh: every-launch",
    "    lifecycle:",
    "      - fresh",
    "      - restart",
    "      - resume",
    "      - fork",
    ...(authorize ? ["    authorize:", "      - bypassPermissions"] : []),
    "",
  ].join("\n");
}

// A private fake home, so the real ~/.claude is never read or written.
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".claude", "settings.json"),
  JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2),
);

const agents: Array<{ name: string; agentId: string; authorize: boolean }> = [
  { name: "good", agentId: "11111111-1111-4111-8111-111111111111", authorize: true },
  { name: "bad", agentId: "22222222-2222-4222-8222-222222222222", authorize: false },
];

const authorities = new Map<string, AgentProfileAuthorityRecord>();
for (const agent of agents) {
  const dir = path.join(root, ".tachyon", "agents", agent.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "agent.yml");
  const bytes = profileYaml(agent.agentId, agent.authorize);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  authorities.set(agent.name, {
    schemaVersion: 1,
    agentName: agent.name,
    agentId: agent.agentId,
    revision: `lifecycle-${agent.agentId}`,
    canonicalSha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    runtimeInspector: CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
  });
}

const yamlText = [
  "agents:",
  ...agents.flatMap((a) => [`  ${a.name}:`, `    profile: .tachyon/agents/${a.name}/agent.yml`]),
  "",
].join("\n");
fs.writeFileSync(path.join(root, "tachyon.yml"), yamlText);

const result = loadProfileAwareConfig({ yamlText, workspaceRoot: root, authorities, homeDir: home });

console.log(`config loaded:       ${result.config ? "yes" : "no"}`);
console.log(`config.agents keys:  ${result.config ? JSON.stringify(Object.keys(result.config.agents)) : "-"}`);
console.log(`agentSources:`);
for (const [name, source] of Object.entries(result.config?.agentSources ?? {})) {
  console.log(`  ${name}: mode=${source.mode}${"reason" in source ? `\n      reason: ${source.reason}` : ""}`);
}
console.log(`profileErrors:       ${JSON.stringify(result.profileErrors, null, 2)}`);
console.log("");
console.log("--- what every removal door asks: isAgentProfileAgent(name) ---");
console.log("      = asAgent(config.agents[name])?.profileLifecycle !== undefined");
for (const agent of agents) {
  const entry = asAgent(result.config?.agents[agent.name]);
  console.log(`  ${agent.name}: ${entry?.profileLifecycle !== undefined}`);
}
console.log("");
console.log("--- what planAgentProfileForget would report for the tachyon.yml row ---");
console.log("      locatorPresent = this.config?.agents[name] !== undefined");
for (const agent of agents) {
  console.log(
    `  ${agent.name}: locatorPresent=${result.config?.agents[agent.name] !== undefined}` +
    `  (tachyon.yml actually declares it: ${yamlText.includes(`  ${agent.name}:`)})`,
  );
}
