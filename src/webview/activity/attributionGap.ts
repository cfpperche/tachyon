import * as nodePath from "node:path";
import { isResumable, type SessionRecord } from "../../resume/SessionLedger.js";
import type { ResumeRuntime } from "../../resume/adapters.js";

type LedgerLike = {
  get(name: string): SessionRecord | undefined;
  all(): Iterable<[string, SessionRecord]>;
};

type ManagerLike = {
  transcriptPathOf(name: string, opts?: { live?: boolean }): Promise<{ path: string; runtime: ResumeRuntime } | undefined>;
};

export type ActivityAttributionWorkspace = {
  ledger: LedgerLike;
  manager: ManagerLike;
};

/**
 * True when another resumable agent shares this agent's cwd AND transcript namespace,
 * and Tachyon cannot currently resolve this agent's owned transcript. This is the
 * Activity panel's "history unavailable" condition.
 */
export async function hasSharedCwdAttributionGap(ws: ActivityAttributionWorkspace, agent: string): Promise<boolean> {
  const mine = ws.ledger.get(agent);
  if (!mine || !isResumable(mine)) return false;
  if (mine.resume?.sessionId) return false;
  const myCwd = nodePath.resolve(mine.cwd);
  const myHome = mine.resume?.configHome;
  const sharesNamespace = [...ws.ledger.all()].some(([name, rec]) => {
    if (name === agent || !isResumable(rec)) return false;
    if (nodePath.resolve(rec.cwd) !== myCwd) return false;
    return sameTranscriptNamespace(myHome, rec.resume?.configHome);
  });
  if (!sharesNamespace) return false;
  const loc = await ws.manager.transcriptPathOf(agent, { live: true }).catch(() => undefined);
  return !loc;
}

function sameTranscriptNamespace(a: string | undefined, b: string | undefined): boolean {
  if (a && b) return nodePath.resolve(a) === nodePath.resolve(b);
  return true;
}
