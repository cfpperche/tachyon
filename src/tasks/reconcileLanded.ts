import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore } from "./TaskStore.js";

const execFileAsync = promisify(execFile);
const SHA = /\b[0-9a-f]{7,40}\b/gi;

export interface LandedGit {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export type LandedReconciliationRow = {
  id: string;
  outcome: "would-reconcile" | "reconciled" | "refused";
  evidence?: string;
  reason?: string;
};

export interface LandedReconciliationReport {
  dryRun: boolean;
  baseRef: string;
  scanned: number;
  wouldReconcile: number;
  reconciled: number;
  refused: number;
  rows: LandedReconciliationRow[];
}

function defaultGit(workspaceRoot: string): LandedGit {
  return {
    async run(args) {
      try {
        const { stdout, stderr } = await execFileAsync("git", args, {
          cwd: workspaceRoot,
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message };
      }
    },
  };
}

async function reachable(git: LandedGit, sha: string, baseRef: string): Promise<boolean> {
  return (await git.run(["merge-base", "--is-ancestor", sha, baseRef])).code === 0;
}

async function resolveCommit(git: LandedGit, candidate: string): Promise<string | undefined> {
  const result = await git.run(["rev-parse", "--verify", `${candidate}^{commit}`]);
  return result.code === 0 && /^[0-9a-f]{40}$/i.test(result.stdout.trim()) ? result.stdout.trim().toLowerCase() : undefined;
}

async function reachableCommitsByTask(git: LandedGit, baseRef: string): Promise<Map<string, string>> {
  const result = await git.run(["log", baseRef, "--format=%H%x09%B%x00"]);
  if (result.code !== 0) throw new Error(`cannot inspect '${baseRef}': ${result.stderr.trim() || "git log failed"}`);
  const found = new Map<string, string>();
  for (const record of result.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const sha = record.slice(0, tab).trim().toLowerCase();
    const body = record.slice(tab + 1);
    for (const id of body.match(/\bt-[0-9a-f]{6}\b/gi) ?? []) {
      if (!found.has(id.toLowerCase())) found.set(id.toLowerCase(), sha);
    }
  }
  return found;
}

async function journalEvidence(tasks: TaskStore, git: LandedGit, id: string, baseRef: string): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const entry of tasks.journal.read(id)) {
    for (const match of entry.text.match(SHA) ?? []) candidates.add(match.toLowerCase());
  }
  for (const candidate of candidates) {
    const sha = await resolveCommit(git, candidate);
    if (sha && await reachable(git, sha, baseRef)) return sha;
  }
  return undefined;
}

async function reproveIdEvidence(git: LandedGit, id: string, sha: string, baseRef: string): Promise<boolean> {
  if (!await reachable(git, sha, baseRef)) return false;
  const show = await git.run(["show", "-s", "--format=%B", sha]);
  return show.code === 0 && new RegExp(`\\b${id}\\b`, "i").test(show.stdout);
}

/**
 * Reconcile the landed lane against strong Git evidence. Dry-run is the default because this is a
 * board-wide mutation: the caller must first see every proposed close and every refusal. Apply
 * re-reads each task and re-proves its individual commit immediately before journalling that SHA.
 */
export async function reconcileLanded(
  tasks: TaskStore,
  workspaceRoot: string,
  options: { dryRun?: boolean; baseRef?: string; actor?: string; git?: LandedGit } = {},
): Promise<LandedReconciliationReport> {
  const dryRun = options.dryRun ?? true;
  const baseRef = options.baseRef ?? "main";
  const git = options.git ?? defaultGit(workspaceRoot);
  const idCommits = await reachableCommitsByTask(git, baseRef);
  const landed = tasks.listRaw().filter((task) => task.status === "landed");
  const rows: LandedReconciliationRow[] = [];

  for (const snapshot of landed) {
    const idSha = idCommits.get(snapshot.id.toLowerCase());
    const evidence = idSha ?? await journalEvidence(tasks, git, snapshot.id, baseRef);
    if (!evidence) {
      rows.push({ id: snapshot.id, outcome: "refused", reason: `no commit evidence reachable from ${baseRef}` });
      continue;
    }
    if (dryRun) {
      rows.push({ id: snapshot.id, outcome: "would-reconcile", evidence });
      continue;
    }
    try {
      const current = tasks.get(snapshot.id);
      if (current.status !== "landed") throw new Error(`status changed from landed to ${current.status}`);
      const stillProved = idSha
        ? await reproveIdEvidence(git, snapshot.id, evidence, baseRef)
        : await reachable(git, evidence, baseRef);
      if (!stillProved) throw new Error(`evidence ${evidence} is no longer proved reachable from ${baseRef}`);
      await tasks.reconcile(snapshot.id, {
        status: "done",
        evidence,
        actor: options.actor ?? "human",
        expect: { status: "landed", updatedAt: current.updatedAt },
      });
      rows.push({ id: snapshot.id, outcome: "reconciled", evidence });
    } catch (error) {
      rows.push({ id: snapshot.id, outcome: "refused", evidence, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    dryRun,
    baseRef,
    scanned: landed.length,
    wouldReconcile: rows.filter((row) => row.outcome === "would-reconcile").length,
    reconciled: rows.filter((row) => row.outcome === "reconciled").length,
    refused: rows.filter((row) => row.outcome === "refused").length,
    rows,
  };
}
