import fs from "node:fs";
import { readEngineEventJournal } from "../engine-service/eventJournal.js";
import { EXECUTION_EVENT_KIND, executionLedgerLocation } from "./executionLedger.js";
import type { SealedExecutionEvent } from "./eventSchema.js";

/**
 * t-c6a89e — read a workspace's execution ledger from the SHELL side, without owning it.
 *
 * Control's Execution section needs these events, and until now nobody handed them to it: the host
 * never supplied the `executionGraph` dependency, so the section returned `undefined` before touching
 * any ledger and rendered `no-telemetry` by construction. The preview fixtures built the view-model
 * directly, which is why the surface looked finished everywhere anyone looked at it.
 *
 * The obvious route — `openExecutionLedger` — is the one thing this must not do. Constructing it
 * builds an `EngineEventJournal`, whose constructor creates the parent directory and, past
 * `maxEvents`, REWRITES the file. The ledger is single-writer by design (t-d5066b) and the writer is
 * the engine daemon; a second process rewriting it is exactly the corruption the contract forbids.
 * So this opens nothing and owns nothing: it stats, parses, and returns.
 */
export interface ExecutionLedgerRead {
  events: SealedExecutionEvent[];
  /**
   * Did a ledger exist to read at all?
   *
   * `false` is "this workspace records nothing yet" — the honest `no-telemetry`. It is NOT the same
   * as a ledger that exists and holds no events, which is a workspace that records and has had
   * nothing to record. The section says different things about those two, so they stay apart here.
   */
  available: boolean;
}

/**
 * Read the ledger for one workspace.
 *
 * Fails honestly rather than quietly: an unreadable or corrupt ledger THROWS, so the caller can show
 * its error state with the reason. Swallowing that into an empty list would report "nothing ran"
 * about a workspace whose history we simply could not read — the same lie this whole area keeps
 * having to unlearn. Only a missing file is an answer, and it is `available: false`.
 */
export function readExecutionLedger(input: {
  storageRoot: string;
  workspaceHash: string;
}): ExecutionLedgerRead {
  const { filePath, streamId } = executionLedgerLocation(input);
  try {
    // `readEngineEventJournal` returns [] for a missing file too, so the existence question is asked
    // here and only here — otherwise "never recorded" and "recorded nothing" would collapse into one.
    fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], available: false };
    throw error;
  }
  const entries = readEngineEventJournal(filePath, streamId);
  const events: SealedExecutionEvent[] = [];
  for (const entry of entries) {
    if (entry.kind === EXECUTION_EVENT_KIND) events.push(entry.payload as unknown as SealedExecutionEvent);
  }
  return { events, available: true };
}
