import { parse as parseYaml } from "yaml";
import { admitAgentRuntimeCommand } from "@tachyon/shared/agents/agentRuntimeAdmission.js";

/**
 * spec 230 — pure loader + validator for a one-shot agent pipeline (`.tachyon/pipelines/<name>.yml`).
 * Mirrors loadConfig's fail-closed, error-accumulating style: returns `{pipeline?, errors}` and never
 * throws on bad input. No side effects — the executor (PipelineManager) consumes a validated PipelineDef.
 */

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/; // matches loadConfig's agent/node name rule

export const DONE_KINDS = ["exit", "signal"] as const;
export type DoneKind = (typeof DONE_KINDS)[number];

export const GATE_KINDS = ["exit:0", "approve"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** done kinds that detect completion by process exit — a declared (interactive) agent can't use these. */
const EXIT_DONE: ReadonlySet<DoneKind> = new Set<DoneKind>(["exit"]);

/**
 * SDD 478 (`t-c003e1`) — what an inline `cmd:` node BECOMES, declared rather than guessed.
 *
 * M9 moved kind out of the manager and into each door; the pipeline door had nowhere to read one, so
 * it asked `suggestKindForCommand(def.cmd)` — the boundary's own inference rule, in the last place
 * that still created an entity with no human in the loop.
 *
 * It turns out the node already declares it. `done:` is the completion contract, and the two arms are
 * exactly the two entities: a signal-based node is handed the task brief and the `complete_node`
 * protocol and must report back through the Bridge — that is an Agent — while an exit-based node runs
 * its command and is judged by the exit code — that is a Terminal. Reading the kind off `done` keeps
 * every existing pipeline valid, adds no key that could disagree with the contract beside it, and
 * makes the answer come from the author instead of from the spelling of the command.
 */
export function nodeKindFromDone(done: DoneKind): "agent" | "terminal" {
  return EXIT_DONE.has(done) ? "terminal" : "agent";
}

export interface NodeDef {
  /** references an agent declared in tachyon.yml (mutually exclusive with cmd) */
  agent?: string;
  /** an inline non-interactive command (mutually exclusive with agent) */
  cmd?: string;
  /**
   * spec 231 — the node's per-step directive. Now OPTIONAL: omittable only for an `agent:` node WITH a
   * persona under `input: required` (the isolated harness carries the persona; the run input carries the
   * work). Required for `cmd:` nodes, persona-less agents, and any `input: none` node (work-source rule).
   */
  task?: string;
  /**
   * `t-c003e1` — what an inline `cmd:` node is spawned AS, materialized from the declared `done`
   * contract (see `nodeKindFromDone`). Absent for an `agent:` node, whose kind is the declared
   * agent's own; the spawn door reads this instead of inferring from the command text.
   */
  kind?: "agent" | "terminal";
  /** upstream node ids this node waits on (default []) */
  needs: string[];
  /** how completion is detected (see the done-contract) */
  done: DoneKind;
  /** optional gate evaluated before the node advances */
  gate?: GateKind;
  /** hard cap; the node fails closed on timeout. Parsed to ms. */
  timeoutMs: number;
}

export interface PipelineDef {
  name: string;
  /** MVP: the run owns one worktree that flows down the chain */
  worktree: "own";
  /** spec 231 — `required` makes ▶ Run collect a run input (the issue); `none` (default) = fixed-task. */
  input: "none" | "required";
  nodes: Record<string, NodeDef>;
}

export interface PipelineParseResult {
  pipeline?: PipelineDef;
  errors: string[];
}

/**
 * spec 230 — the tmux/ledger name a node spawns under. An `agent:` node IS the declared specialist
 * agent (so it persists in the tree and is stopped — not destroyed — when done); a `cmd:` node is an
 * ephemeral Temporary spawn `pl-<runId>-<nodeId>` (dismissed when done).
 */
export const nodeSpawnName = (runId: string, nodeId: string, def: Pick<NodeDef, "agent">): string => def.agent ?? `pl-${runId}-${nodeId}`;

/** Parse a duration like `30s` / `45m` / `2h` to milliseconds; null on a malformed value. */
export function parseDuration(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d+)(s|m|h)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
  return n * unit;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Detect a cycle in the needs-graph; returns the ids on a cycle (empty if acyclic). Refs are assumed valid. */
function findCycle(nodes: Record<string, NodeDef>): string[] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  for (const id of Object.keys(nodes)) color.set(id, WHITE);

  const visit = (id: string): string[] | null => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of nodes[id].needs) {
      if (!nodes[dep]) continue; // unknown ref already reported elsewhere
      const c = color.get(dep);
      if (c === GRAY) return stack.slice(stack.indexOf(dep)); // back-edge → cycle
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of Object.keys(nodes)) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return [];
}

function parseNode(
  id: string,
  raw: unknown,
  knownAgents: ReadonlySet<string>,
  inputMode: "none" | "required",
  agentHasPersona: (name: string) => boolean,
  errors: string[],
): NodeDef | null {
  if (!isPlainObject(raw)) {
    errors.push(`nodes.${id}: must be a mapping`);
    return null;
  }
  const hasAgent = typeof raw.agent === "string" && raw.agent.trim().length > 0;
  const hasCmd = typeof raw.cmd === "string" && raw.cmd.trim().length > 0;
  if (hasAgent === hasCmd) {
    errors.push(`nodes.${id}: exactly one of 'agent' or 'cmd' is required`);
  } else if (hasAgent && !knownAgents.has(raw.agent as string)) {
    errors.push(`nodes.${id}.agent: '${raw.agent as string}' is not a declared agent in tachyon.yml`);
  }

  // spec 231 work-source rule (codex B1/M2): a node needs a work source. `task` is required EXCEPT for an
  // `agent:` node that has a persona AND runs under `input: required` (persona = harness, work = the run
  // input). `cmd:` nodes and persona-less / `input: none` agents still require `task`, fail-closed.
  const hasTask = typeof raw.task === "string" && (raw.task as string).trim().length > 0;
  const taskOptional = hasAgent && inputMode === "required" && agentHasPersona(raw.agent as string);
  if (!hasTask && !taskOptional) {
    errors.push(
      `nodes.${id}.task: a non-empty task is required (optional only for an agent node with a persona under 'input: required')`,
    );
  }

  let needs: string[] = [];
  if (raw.needs !== undefined) {
    if (!Array.isArray(raw.needs) || raw.needs.some((d) => typeof d !== "string")) {
      errors.push(`nodes.${id}.needs: must be a list of node ids`);
    } else {
      needs = raw.needs as string[];
      if (needs.includes(id)) errors.push(`nodes.${id}.needs: a node cannot depend on itself`);
    }
  }

  const done = raw.done;
  if (typeof done !== "string" || !(DONE_KINDS as readonly string[]).includes(done)) {
    errors.push(`nodes.${id}.done: required, one of ${DONE_KINDS.join(" | ")}`);
  } else if (hasAgent && EXIT_DONE.has(done as DoneKind)) {
    // a declared agent is an interactive LLM — it doesn't process-exit; it must signal.
    errors.push(`nodes.${id}.done: '${done}' is exit-based — a declared agent is interactive and must use a signal kind`);
  }
  // NOTE: a `cmd:` node may use EITHER kind: `exit` for a non-interactive one-shot
  // (sh / codex exec / claude -p), OR `signal` for an EPHEMERAL interactive LLM
  // agent (e.g. `cmd: codex` with the workspace's default config — it gets the task + complete_node
  // protocol + nonce, signals when done, then is dismissed). spec 230.
  //
  // `t-c003e1` — and because that choice IS the node's kind, a signal-based inline node faces the same
  // admission the Temporary door applies: Tachyon must be able to name the runtime it would operate.
  // Refused here, at load, where the author can see which line to change — not at spawn, three states
  // into a run.
  if (hasCmd && typeof done === "string" && !EXIT_DONE.has(done as DoneKind)) {
    const admission = admitAgentRuntimeCommand(raw.cmd as string);
    if (!admission.ok) {
      errors.push(
        `nodes.${id}.cmd: '${(raw.cmd as string).trim()}' cannot run as an agent node — ${admission.reason}`
        + ` In a pipeline, the Terminal form of a node is \`done: exit\`,`
        + ` which runs the command as-is and judges it by its exit code; \`agent: <name>\` runs a declared agent instead.`,
      );
    }
  }

  if (raw.gate !== undefined && !(GATE_KINDS as readonly string[]).includes(raw.gate as string)) {
    errors.push(`nodes.${id}.gate: must be one of ${GATE_KINDS.join(" | ")}`);
  }


  const timeoutMs = parseDuration(raw.timeout);
  if (timeoutMs === null) {
    errors.push(`nodes.${id}.timeout: required, a positive duration like '30s' / '45m' / '2h'`);
  }

  if (errors.length > 0) return null; // a node with any error isn't materialized
  return {
    ...(hasAgent ? { agent: raw.agent as string } : { cmd: raw.cmd as string, kind: nodeKindFromDone(done as DoneKind) }),
    ...(hasTask ? { task: (raw.task as string).trim() } : {}),
    needs,
    done: done as DoneKind,
    ...(raw.gate !== undefined ? { gate: raw.gate as GateKind } : {}),
    timeoutMs: timeoutMs as number,
  };
}

/**
 * Parse + validate pipeline YAML text against the set of agent names declared in tachyon.yml.
 * `agentHasPersona(name)` (spec 231) reports whether a declared agent carries a persona (role/instructions
 * or an isolated harness) — only such an agent may omit `task` under `input: required`. Defaults to a
 * conservative `() => false` (no persona known → `task` required), so existing callers stay fail-closed.
 */
export function loadPipeline(
  text: string,
  knownAgents: ReadonlySet<string>,
  agentHasPersona: (name: string) => boolean = () => false,
): PipelineParseResult {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    return { errors: [`invalid YAML: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!isPlainObject(doc)) return { errors: ["pipeline must be a mapping"] };

  if (typeof doc.name !== "string" || !NAME_RE.test(doc.name)) {
    errors.push(`name: required, must match ${NAME_RE}`);
  }

  let worktree: "own" = "own";
  if (doc.worktree !== undefined) {
    if (doc.worktree !== "own") errors.push(`worktree: only 'own' is supported in v1 (got '${String(doc.worktree)}')`);
    else worktree = "own";
  }

  // spec 231 — `input: none|required` (default none/absent). Fail-closed enum, like worktree.
  let inputMode: "none" | "required" = "none";
  if (doc.input !== undefined) {
    if (doc.input !== "none" && doc.input !== "required") {
      errors.push(`input: only 'none' or 'required' is supported (got '${String(doc.input)}')`);
    } else {
      inputMode = doc.input;
    }
  }

  if (!isPlainObject(doc.nodes) || Object.keys(doc.nodes).length === 0) {
    errors.push("nodes: a non-empty mapping of node id -> node is required");
    return { errors };
  }

  const nodes: Record<string, NodeDef> = {};
  for (const [id, raw] of Object.entries(doc.nodes)) {
    if (!NAME_RE.test(id)) {
      errors.push(`nodes.${id}: invalid node id (must match ${NAME_RE})`);
      continue;
    }
    const nodeErrors: string[] = [];
    const node = parseNode(id, raw, knownAgents, inputMode, agentHasPersona, nodeErrors);
    errors.push(...nodeErrors);
    if (node) nodes[id] = node;
  }

  // unknown needs refs (only check ids that parsed cleanly)
  for (const [id, node] of Object.entries(nodes)) {
    for (const dep of node.needs) {
      if (!nodes[dep] && !(doc.nodes as Record<string, unknown>)[dep]) {
        errors.push(`nodes.${id}.needs: unknown node '${dep}'`);
      }
    }
  }

  // cycle detection only when every node parsed (a partial graph can't be soundly checked)
  if (errors.length === 0) {
    const cycle = findCycle(nodes);
    if (cycle.length > 0) errors.push(`nodes: dependency cycle detected (${cycle.join(" -> ")} -> ${cycle[0]})`);
  }

  // v1 (codex S4 BLOCKER): `worktree: own` runs nodes sequentially in ONE shared checkout, so two
  // runnable siblings would clobber it. Require a single linear chain (one root, no fan-in / fan-out);
  // parallel nodes (read-only or per-node sub-worktrees) are a follow pass.
  if (errors.length === 0) {
    const ids = Object.keys(nodes);
    const roots = ids.filter((id) => nodes[id].needs.length === 0);
    const fanIn = ids.some((id) => nodes[id].needs.length > 1);
    const dependents = new Map<string, number>();
    for (const id of ids) for (const dep of nodes[id].needs) dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
    const fanOut = ids.some((id) => (dependents.get(id) ?? 0) > 1);
    if (roots.length !== 1 || fanIn || fanOut) {
      errors.push("nodes: a v1 pipeline must be a single linear chain (one root, no fan-in/fan-out); parallel nodes are a follow pass");
    }
    // a declared agent is a single persistent resource → two nodes can't both BE it in one run (codex M2).
    const agentRefs = ids.map((id) => nodes[id].agent).filter((a): a is string => !!a);
    const dupAgent = agentRefs.find((a, i) => agentRefs.indexOf(a) !== i);
    if (dupAgent) errors.push(`nodes: agent '${dupAgent}' is referenced by more than one node — a declared pipeline agent can serve only one node per run`);
  }

  if (errors.length > 0) return { errors };
  return { pipeline: { name: doc.name as string, worktree, input: inputMode, nodes }, errors: [] };
}
