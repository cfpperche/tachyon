/**
 * t-bbe760 — orphan-residue reproduction for `docs/specs/494-.../evidence/orphan-hunt-2026-08-07.md`.
 *
 * Drives the PRODUCTION helpers in a throwaway workspace and prints what survives, plus what the
 * only sweep that reads `.tachyon/agents/` says about it. Read-only against the repository.
 *
 *   ./node_modules/.bin/vite-node docs/specs/494-saved-agent-state-ownership/evidence/orphan-repro.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { publishAgentProfile, removeAgentProfileIfExact } from "../../../../src/config/agentProfileTransactions.js";
import { deriveSavedAgentState, savedAgentRemovalDoor } from "../../../../src/config/savedAgentState.js";
import { forgetAgent } from "../../../../src/agents/forgetAgent.js";

const digest = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const child = path.join(d, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (fs.lstatSync(child).isDirectory()) { out.push(`${childRel}/`); walk(child, childRel); }
      else out.push(childRel);
    }
  };
  walk(root, "");
  return out;
}

/** The exact four facts the roster reconciler measures (`Workspace.ts:4139-4149`). */
function facts(ws: string, name: string, rosterRow: boolean, authorityRecord: boolean) {
  return {
    rosterRow,
    // Workspace.ts:4145 — the expression under test: the FILE, not the directory.
    profileOnDisk: fs.existsSync(path.join(ws, ".tachyon", "agents", name, "agent.yml")),
    authorityRecord,
    projection: false,
  };
}

function report(title: string, ws: string, name: string, rosterRow: boolean, authority: boolean) {
  const f = facts(ws, name, rosterRow, authority);
  const state = deriveSavedAgentState(f);
  const door = savedAgentRemovalDoor(state);
  const agentsRoot = path.join(ws, ".tachyon", "agents");
  const dir = path.join(agentsRoot, name);
  const dirExists = fs.existsSync(dir);
  console.log(`\n--- ${title} ---`);
  console.log(`  savedAgentSubjects sees (readdir)  : ${JSON.stringify(fs.existsSync(agentsRoot) ? fs.readdirSync(agentsRoot) : [])}`);
  console.log(`  .tachyon/agents/${name}/ exists    : ${dirExists}`);
  console.log(`  its contents                       : ${JSON.stringify(dirExists ? tree(dir) : [])}`);
  console.log(`  presence facts                     : ${JSON.stringify(f)}`);
  console.log(`  deriveSavedAgentState              -> ${state}`);
  console.log(`  savedAgentRemovalDoor.door         -> ${JSON.stringify(door.door)}`);
  console.log(`  reason                             : ${door.reason}`);
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "orphanhunt-"));
fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true, mode: 0o700 });

// ============================================================================
// ORIGIN A — a canonical create that rolled back.
// `agentProfileLifecycle.compensate` takes the create branch at :588-591 and calls
// `removeAgentProfileIfExact`; the config backup at :612-614 puts the roster row back the
// way it was, i.e. absent. So both halves of the create are undone — except the directory.
// ============================================================================
const A = "ghost-create";
const profileText = "schemaVersion: 1\nagentId: 11111111-1111-4111-8111-111111111111\n";
publishAgentProfile(ws, A, profileText);
console.log(`\n[A] after publishAgentProfile   : ${JSON.stringify(tree(path.join(ws, ".tachyon", "agents")))}`);
removeAgentProfileIfExact(ws, A, digest(profileText));
report("ORIGIN A: create rolled back (removeAgentProfileIfExact)", ws, A, false, false);

// ============================================================================
// ORIGIN B — `forgetAgent` reaches into a profile home for one child and leaves the parent.
// The home is seeded the way `EvolutionStore.atomicWrite` (:2014) seeds it: `mkdir -p` of
// `.tachyon/agents/<name>/evolution/`, whose recursive create makes the parent too.
// ============================================================================
const B = "ghost-evolution";
fs.mkdirSync(path.join(ws, ".tachyon", "agents", B, "evolution"), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(ws, ".tachyon", "agents", B, "evolution", "profile.json"), "{}\n");
console.log(`\n[B] after Evolution mkdir -p    : ${JSON.stringify(tree(path.join(ws, ".tachyon", "agents", B)))}`);
forgetAgent(B, { workspaceRoot: ws });
report("ORIGIN B: forgetAgent after Evolution (forgetAgent.ts:57)", ws, B, false, false);

// ============================================================================
// CONTROL — the same detector, with `agent.yml` present. It names the disagreement correctly.
// The difference between this block and the two above is the FORMAT of the residue, nothing else.
// ============================================================================
const C = "healthy";
publishAgentProfile(ws, C, profileText);
report("CONTROL: profile present, roster row present", ws, C, true, true);
report("CONTROL: profile present, roster row absent", ws, C, false, true);

console.log(`\nworkspace kept at: ${ws}`);
