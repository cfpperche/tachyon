/**
 * SDD 480 Phase 4 — the Execution Graph section: a canvas and an accessible table of the SAME model.
 *
 * The table is not a fallback and not a degraded view. It is the same information, and it is what
 * makes the surface usable with a screen reader, with keyboard only, at 760px, and when a reader
 * simply wants to sort and read rather than look. Both renderings consume one `ExecutionGraphVm`, so
 * "they agree" is not something anyone has to maintain — divergence is inexpressible.
 *
 * SVG rather than a canvas element or a graph library, deliberately: the plan rules out a heavy
 * dependency or a layout engine, and coordinates already arrive computed and deterministic. SVG also
 * keeps every node a real DOM element, which is what lets the diagram be tested and inspected instead
 * of being an opaque bitmap.
 *
 * NO DESTRUCTIVE ACTIONS. There are no buttons here that kill, retry or mutate anything — selection
 * is the only interaction, and the view-model behind it cannot describe a mutation.
 */
import type { CockpitStrings } from "./messages";
import type {
  ExecutionGraphVm,
  ExecutionGraphDetailVm,
  ExecutionGraphNodeVm,
  ExecutionGraphRowVm,
} from "../../cockpit/executionGraphVm";
import { NODE_HEIGHT, NODE_WIDTH } from "../../cockpit/executionGraphVm";

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function attributionLabel(s: CockpitStrings, attribution: ExecutionGraphRowVm["attribution"]): string {
  return attribution === "proven" ? s.egAttrProven : attribution === "shared" ? s.egAttrShared : s.egAttrUnproven;
}

/** State drives a class, never a bare colour: colour alone is not an accessible signal. */
function stateTone(state: string): string {
  if (state === "failed" || state === "killed") return "err";
  if (state === "completed") return "ok";
  if (state === "shared") return "shared";
  if (state === "orphaned" || state === "unproven") return "warn";
  return "run";
}

function Diagram({ s, vm, selected, onSelect }: {
  s: CockpitStrings;
  vm: ExecutionGraphVm;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div class="ck-eg-canvas-wrap">
      <svg
        class="ck-eg-canvas"
        viewBox={`-8 -8 ${vm.width + 16} ${vm.height + 16}`}
        // The diagram is decorative FOR A SCREEN READER — the table below carries the same content in
        // a form that actually reads. Announcing both would make a keyboard user hear everything twice.
        role="img"
        aria-label={s.egCanvasLabel}
        preserveAspectRatio="xMinYMin meet"
      >
        {vm.edges.map((edge) => (
          <line
            key={`${edge.from}-${edge.to}-${edge.kind}`}
            class="ck-eg-edge"
            x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2}
          />
        ))}
        {vm.nodes.map((node) => (
          <g
            key={node.executionId}
            class={`ck-eg-node ck-eg-node--${stateTone(node.state)}${selected === node.executionId ? " is-selected" : ""}`}
            transform={`translate(${node.x},${node.y})`}
            onClick={() => onSelect(node.executionId)}
          >
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="6" />
            <text x="10" y="17" class="ck-eg-node-label">{node.label}</text>
            <text x="10" y="31" class="ck-eg-node-sub">
              {node.state}
              {node.shared ? " · shared" : ""}
              {node.unproven ? " · unproven" : ""}
              {node.orphaned ? " · orphaned" : ""}
              {node.groupSize > 1 ? ` · ×${node.groupSize}` : ""}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Table({ s, vm, selected, onSelect }: {
  s: CockpitStrings;
  vm: ExecutionGraphVm;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <table class="ds-table ck-eg-table">
      <caption class="ck-sr-only">{s.egTableLabel}</caption>
      <thead>
        <tr>
          <th scope="col">{s.egColKind}</th>
          <th scope="col">{s.egColState}</th>
          <th scope="col">{s.egColAgents}</th>
          <th scope="col">{s.egColAttribution}</th>
          <th scope="col">{s.egColStarted}</th>
          <th scope="col">{s.egColDuration}</th>
          <th scope="col">{s.egColExit}</th>
        </tr>
      </thead>
      <tbody>
        {vm.rows.map((row) => (
          <tr
            key={row.executionId}
            class={selected === row.executionId ? "is-selected" : undefined}
            // A row is the selection control, so it must be reachable and operable by keyboard —
            // the diagram's click target has no keyboard equivalent, and this is it.
            tabIndex={0}
            aria-selected={selected === row.executionId}
            onClick={() => onSelect(row.executionId)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(row.executionId); }
            }}
          >
            <td>{row.kind}{row.groupSize > 1 ? ` ×${row.groupSize}` : ""}</td>
            <td><span class={`ds-badge ds-badge--${stateTone(row.state)}`}>{row.state}</span></td>
            <td>{row.agents || "—"}</td>
            <td>{attributionLabel(s, row.attribution)}</td>
            <td>{row.startedAt}</td>
            <td>{formatDuration(row.durationMs)}</td>
            <td>{row.exitCode ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Detail({ s, detail }: { s: CockpitStrings; detail?: ExecutionGraphDetailVm }) {
  if (!detail) return <p class="ck-eg-detail-empty">{s.egDetailNone}</p>;
  // Every row is rendered only when the ledger actually recorded it. An unknown cwd is absent, never
  // an empty string, because a blank value beside a label reads as a fact rather than as a gap.
  return (
    <dl class="ck-eg-detail">
      <dt>{s.egColState}</dt><dd>{detail.state}</dd>
      <dt>{s.egDetailDuration}</dt><dd>{formatDuration(detail.durationMs)}</dd>
      {detail.exitCode !== undefined && (<><dt>{s.egDetailExit}</dt><dd>{detail.exitCode}</dd></>)}
      {detail.cwd && (<><dt>{s.egDetailCwd}</dt><dd class="ck-eg-mono">{detail.cwd}</dd></>)}
      {detail.worktree && (<><dt>{s.egDetailWorktree}</dt><dd class="ck-eg-mono">{detail.worktree}</dd></>)}
      {detail.tool && (<><dt>{s.egDetailTool}</dt><dd>{detail.tool}</dd></>)}
      {detail.turnId && (<><dt>{s.egDetailTurn}</dt><dd class="ck-eg-mono">{detail.turnId}</dd></>)}
      {detail.toolCallId && (<><dt>{s.egDetailToolCall}</dt><dd class="ck-eg-mono">{detail.toolCallId}</dd></>)}
      <dt>{s.egDetailIdentity}</dt>
      <dd>
        {/* The spec's central claim, shown per agent rather than as one merged verdict: a shared
            execution can be proven for one agent and unproven for another, and collapsing that is
            exactly how false ownership gets displayed as fact. */}
        <ul class="ck-eg-identity">
          {detail.identityProof.map((proof) => (
            <li key={proof.agentId}>
              <span class="ck-eg-mono">{proof.agentId}</span>
              {" — "}
              <span class={`ds-badge ds-badge--${proof.provenance === "measured" ? "ok" : "warn"}`}>{proof.provenance}</span>
            </li>
          ))}
        </ul>
      </dd>
    </dl>
  );
}

export function ExecutionGraphSection({ s, vm, detail, selected, filters, onSelect, onFilter }: {
  s: CockpitStrings;
  vm: ExecutionGraphVm;
  detail?: ExecutionGraphDetailVm;
  selected?: string;
  filters: { turnId?: string; state?: string; kind?: string; agentId?: string };
  onSelect: (id: string) => void;
  onFilter: (next: { turnId?: string; state?: string; kind?: string; agentId?: string }) => void;
}) {
  // Each non-ready status gets its OWN message. They are different facts about the world and a shared
  // "nothing here" would erase the difference that matters most (see `no-telemetry`).
  if (vm.status !== "ready") {
    const message = vm.status === "loading" ? s.egLoading
      : vm.status === "no-telemetry" ? s.egNoTelemetry
      : vm.status === "error" ? s.egError
      : s.egEmpty;
    return (
      <div class="ck-eg-state" role={vm.status === "error" ? "alert" : "status"}>
        <p>{message}</p>
        {vm.status === "error" && vm.errorDetail && <p class="ck-eg-mono">{vm.errorDetail}</p>}
      </div>
    );
  }

  const select = (key: "turnId" | "state" | "kind" | "agentId", label: string, options: string[]) => (
    <label class="ck-eg-filter">
      <span>{label}</span>
      <select
        value={filters[key] ?? ""}
        onChange={(e) => onFilter({ ...filters, [key]: (e.target as HTMLSelectElement).value || undefined })}
      >
        <option value="">{s.egFilterAll}</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );

  return (
    <div class="ck-eg">
      <div class="ck-eg-filters" role="group" aria-label={s.executionGraphTitle}>
        {select("turnId", s.egFilterTurn, vm.available.turnIds)}
        {select("state", s.egFilterState, vm.available.states)}
        {select("kind", s.egFilterKind, vm.available.kinds)}
        {select("agentId", s.egFilterAgent, vm.available.agentIds)}
      </div>
      {/* Said out loud rather than left to be inferred from a short list: a grouped view that stays
          silent is indistinguishable from a complete one. */}
      {vm.grouped && <p class="ck-eg-grouped" role="status">{s.egGroupedNote} ({vm.matched})</p>}
      <div class="ck-eg-body">
        <div class="ck-eg-main">
          <Diagram s={s} vm={vm} selected={selected} onSelect={onSelect} />
          <Table s={s} vm={vm} selected={selected} onSelect={onSelect} />
        </div>
        <aside class="ck-eg-side" aria-label={s.egDetailTitle}>
          <h3>{s.egDetailTitle}</h3>
          <Detail s={s} detail={detail} />
        </aside>
      </div>
    </div>
  );
}

export type { ExecutionGraphNodeVm };
