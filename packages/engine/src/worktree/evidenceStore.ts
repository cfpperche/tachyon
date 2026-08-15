/**
 * t-1d198e — evidence records live next to their files.
 *
 * The caption used to live only in sessions.json (sessions.<agent>.worktree.evidence[]).
 * dismissTemporary → forgetAgent → ledger.remove deleted that row and left the bytes in
 * `.tachyon/evidence/<agent>/<id>/` with no text. The record now sits in that same directory
 * as `record.json`, so the two die together or not at all.
 *
 * sessions.json is no longer the home. A ledger copy, if present, is a fallback for records
 * written before this change; listing migrates those onto disk so a later dismiss cannot take them.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { evidenceArtifactRelDir, parseWorktreeEvidence, type WorktreeEvidence } from "./evidence.js";

const RECORD_NAME = "record.json";

function recordPath(workspaceRoot: string, agent: string, id: string): string {
  return path.join(workspaceRoot, evidenceArtifactRelDir(agent, id), RECORD_NAME);
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* rename failure is the real error */ }
    throw error;
  }
}

export function persistEvidenceRecord(workspaceRoot: string, record: WorktreeEvidence): void {
  writeAtomic(recordPath(workspaceRoot, record.targetAgent, record.id), `${JSON.stringify(record, null, 2)}\n`);
}

export function loadEvidenceRecords(
  workspaceRoot: string,
  agent: string,
  fallback: readonly WorktreeEvidence[] = [],
): WorktreeEvidence[] {
  const byId = new Map<string, WorktreeEvidence>();
  const dir = path.join(workspaceRoot, ".tachyon", "evidence", agent);
  if (fs.existsSync(dir)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const file = path.join(dir, entry, RECORD_NAME);
      try {
        const parsed = parseWorktreeEvidence(JSON.parse(fs.readFileSync(file, "utf8")));
        if (parsed) byId.set(parsed.id, parsed);
      } catch {
        /* missing or corrupt record.json is not a caption we can show */
      }
    }
  }
  for (const record of fallback) {
    if (byId.has(record.id)) continue;
    byId.set(record.id, record);
    try {
      persistEvidenceRecord(workspaceRoot, record);
    } catch {
      /* listing still returns the fallback; a later write can retry the migrate */
    }
  }
  return [...byId.values()];
}
