/**
 * t-bbe760 — does the Soul door accept a `terminals:` name, and what does the roster
 * reconciler say about the profile home it then publishes?
 *
 *   ./node_modules/.bin/vite-node docs/specs/494-saved-agent-state-ownership/evidence/orphan-terminal-soul-repro.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentStanzaCasToken } from "../../../../src/config/YamlConfigEditor.js";
import { deriveSavedAgentState, savedAgentRemovalDoor } from "../../../../src/config/savedAgentState.js";
import { publishCanonicalSoulFiles } from "../../../../src/agents/soul.js";

const yml = [
  "agents:",
  "  claude:",
  "    profile: .tachyon/agents/claude/agent.yml",
  "terminals:",
  "  shell:",
  "    cmd: bash",
  "",
].join("\n");

// soulProfileTransactions.ts:589/624/691/738/766/784/814 all gate on `journal.priorConfig.present`,
// and that token comes from `agentStanzaCasToken`, whose `sectionOf` accepts BOTH blocks
// (YamlConfigEditor.ts:36-40).
console.log("=== the gate every Soul mutation uses ===");
for (const name of ["claude", "shell", "nobody"]) {
  const token = agentStanzaCasToken(yml, name);
  console.log(`  agentStanzaCasToken(yml, ${JSON.stringify(name).padEnd(9)}).present = ${String(token.present).padEnd(5)}`
    + ` -> Soul create/import ${token.present ? "PROCEEDS" : "refused (soul/path-invalid)"}`);
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "orphanhunt-terminal-"));
fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true, mode: 0o700 });

const bytes = Buffer.from("# Soul\n\nI am the shell terminal.\n", "utf8");
await publishCanonicalSoulFiles(ws, "shell", bytes, {
  schemaVersion: 1,
  profileId: "22222222-2222-4222-8222-222222222222",
  owner: "shell",
  state: "active",
});

console.log(`\n=== after publishCanonicalSoulFiles(ws, "shell", …) ===`);
console.log(`  .tachyon/agents/ listing  : ${JSON.stringify(fs.readdirSync(path.join(ws, ".tachyon", "agents")))}`);
console.log(`  .tachyon/agents/shell/    : ${JSON.stringify(fs.readdirSync(path.join(ws, ".tachyon", "agents", "shell")))}`);
console.log(`  tachyon.yml agents block  : ["claude"]  <- "shell" is not in it`);

const facts = {
  rosterRow: false, // no `agents:` row; the row it has is under `terminals:`
  profileOnDisk: fs.existsSync(path.join(ws, ".tachyon", "agents", "shell", "agent.yml")),
  authorityRecord: false,
  projection: false,
};
const state = deriveSavedAgentState(facts);
console.log(`\n  presence facts            : ${JSON.stringify(facts)}`);
console.log(`  deriveSavedAgentState     -> ${state}`);
console.log(`  savedAgentRemovalDoor     -> ${JSON.stringify(savedAgentRemovalDoor(state))}`);
console.log(`\nworkspace kept at: ${ws}`);
