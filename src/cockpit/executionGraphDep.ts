import { engineStorageRoot } from "../engine-service/engineSupervisor.js";
import { readExecutionLedger } from "../executionGraph/executionLedgerReader.js";
import type { EngineCurrency } from "../engine-service/engineCurrency.js";
import type { SealedExecutionEvent } from "../executionGraph/eventSchema.js";

/** The part of a workspace handle this dependency needs, and nothing more. */
export interface ExecutionGraphWorkspace {
  workspaceRoot: string;
  wsHash: string;
  client: { engineCurrency: EngineCurrency };
}

/**
 * t-c6a89e — build Control's `executionGraph` dependency.
 *
 * It lives here, rather than inline in `activate()`, so a test can drive the PRODUCTION wiring. That
 * is not a stylistic preference: this whole task exists because the dependency was declared,
 * documented, consumed by a tested builder — and never supplied. Every test around it passed. The
 * preview fixtures built the view-model directly, so the surface looked finished from every angle
 * anyone checked. A defect that survives that much green survives an inline closure too.
 *
 * `storageRootFor` is a seam for tests to point at a temp directory instead of the real per-user
 * state root. Production takes the default and this file is the only place that decides it.
 */
export function makeExecutionGraphDep(
  byHash: (hash: string | undefined) => ExecutionGraphWorkspace | undefined,
  storageRootFor: (workspaceRoot: string) => string = engineStorageRoot,
): (wsHash: string | undefined) => { events: SealedExecutionEvent[]; available: boolean; currency?: EngineCurrency } {
  return (wsHash) => {
    const ws = byHash(wsHash);
    // No workspace resolved — none open, or several with none selected — is not "this workspace has
    // no telemetry". It is no workspace to have telemetry about. Same absent answer, honest reason,
    // and deliberately no `currency`: there is no engine here whose age could explain anything.
    if (!ws) return { events: [], available: false };
    const read = readExecutionLedger({
      storageRoot: storageRootFor(ws.workspaceRoot),
      workspaceHash: ws.wsHash,
    });
    // t-f54b62 — carried so an empty section can say WHY, when the daemon predates the build that
    // would have recorded. The client answers `unknown` when it did not actually compare.
    return { ...read, currency: ws.client.engineCurrency };
  };
}
