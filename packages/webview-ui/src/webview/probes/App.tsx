import type { ComponentChildren } from "preact";
import type { ProbeViewRow } from "@tachyon/engine/probe/probeView.js";
import type { ProbesVM } from "./messages";

// spec 279 — the Probes view (converted from ProbeResultPanel's inline HTML). Read-only: renders the engine's
// ProbeView. preact escapes all text by default — no manual esc() needed (the old inline path hand-escaped).

/**
 * SDD 475 — the model that ACTUALLY ran, per the run's own provenance. The cell only ever prints an
 * effective identifier, the literal `unproven`, or `—`; the requested model lives in the tooltip so
 * it can never be misread as the model that answered.
 */
function Model({ row }: { row: ProbeViewRow }) {
  return <span class={`model model-${row.modelState}`} title={row.modelTitle}>{row.model}</span>;
}

function Status({ status }: { status: ProbeViewRow["status"] }) {
  if (status === "running") return <span class="st run">● running</span>;
  if (status === "completed") return <span class="st ok">✓ completed</span>;
  return <span class="st fail">✗ failed</span>;
}

export function App({ vm, backLink }: { vm: ProbesVM | undefined; /** t-bf3498 — the route's "← Parent" back-link, rendered under the title. */ backLink?: ComponentChildren }) {
  if (!vm) return <div class="probes-root empty">{backLink ? <div class="ds-degrade-backlink">{backLink}</div> : null}<p>Loading…</p></div>;
  // spec 322 — a caller-scoped view is THIS agent's probe history; the unfiltered form is the internal
  // escape hatch for caller-less/orphaned records.
  const caller = "view" in vm ? vm.view.caller : undefined;
  const title = caller ? `⌕ Probes — ${caller} (${vm.folder})` : `⌕ Captured probes — ${vm.folder}`;
  if ("error" in vm) {
    return (
      <div class="probes-root">
        <h1>{title}</h1>
        {backLink ? <div class="ds-page-chrome-backlink">{backLink}</div> : null}
        <div class="error"><p>Could not load probes.</p><p class="hint">{vm.error}</p></div>
      </div>
    );
  }
  const view = vm.view;
  return (
    <div class="probes-root">
      <h1>{title}</h1>
      {backLink ? <div class="ds-page-chrome-backlink">{backLink}</div> : null}
      {view.empty ? (
        <div class="empty">
          <p>{caller ? `No probes launched by '${caller}' yet.` : "No probes yet."}</p>
          <p class="hint">Run one with the <code>probe_agent</code> Bridge tool — an adversarial-review or factual-verify second-model pass{caller ? ` (pass caller: "${caller}")` : ""}.</p>
        </div>
      ) : (
        <>
          <div class="counts">
            <span>{view.total} total</span>
            <span class="ok">{view.completed} completed</span>
            <span class="fail">{view.failed} failed</span>
            <span class="run">{view.running} running</span>
          </div>
          <table>
            <thead>
              <tr><th>id</th><th>status</th><th>reason</th><th>runtime</th><th>model</th><th>archetype</th><th>caller</th><th>age</th><th>excerpt</th></tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.runId}>
                  <td class="mono">{r.shortId}</td>
                  <td><Status status={r.status} /></td>
                  <td>{r.reason}</td>
                  <td>{r.runtime}</td>
                  <td class="model-cell"><Model row={r} /></td>
                  <td class="arch">{r.archetype}</td>
                  <td>{r.caller}</td>
                  <td class="age">{r.ageLabel}</td>
                  <td class="exc">{r.excerpt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
