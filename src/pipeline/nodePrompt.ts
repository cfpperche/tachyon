/**
 * spec 231 — pure assembly of a pipeline node's spawn prompt.
 *
 * Extracted out of `Workspace.ts` so the composition is unit-tested (memory
 * `feedback_logic_in_vscode_layer_escapes_ci` — still the right general rule for genuinely
 * vscode-bound code such as panel/provider hosts). The whole point of the extraction is the
 * EQUIVALENCE LOCK: a node with a `task` and no run input / no upstream summaries must produce
 * EXACTLY today's string (`${task}\n\n${GUIDANCE}`), so the 230 engine stays byte-identical.
 *
 * t-93dbf2 — this header used to add "(which CI cannot import)" about `Workspace.ts`. That has NOT
 * been true since spec 233 introduced the host port: `Workspace.ts` imports no `vscode` (it calls
 * the injected `VsCodeHost` instead) and 27 `test/unit` files import it, most as a value. The
 * extraction above remains correct on its own merits — a pure module with an equivalence lock is
 * better than inline assembly — but do NOT cite an import barrier that no longer exists as the
 * reason to move logic out of, or avoid touching, `Workspace.ts`.
 *
 * The optional run `input` and the upstream handoff `summary`s are CONDITIONAL sections — absent inputs
 * produce no section at all. Summaries are agent-authored free text → rendered under an explicit
 * untrusted header and sanitized/capped by `sanitizeSummary` before they ever reach here.
 */

/** spec 230 — appended to a pipeline node's prompt so it signals completion when done. (moved from Workspace) */
export const PIPELINE_NODE_GUIDANCE =
  "— Tachyon pipeline node —\n" +
  "When this task is FULLY complete, signal Tachyon by calling the `complete_node` MCP tool with the " +
  "runId, nodeId, and nonce from your environment (read them with `printenv TACHYON_RUN_ID`, " +
  "`printenv TACHYON_NODE_ID`, `printenv TACHYON_NODE_NONCE`). The pipeline will not advance until you do. " +
  "Do not call it until the work is genuinely finished (a verify gate may run after your signal).";

/** Default cap for an agent-reported handoff summary (codex 231 MAJOR-3: untrusted, size-bound). */
export const SUMMARY_CAP_BYTES = 4096;

const TRUNCATION_MARKER = "\n…[truncated]";

/** An upstream node's handoff, as stored (attributed) in the run ledger. */
export interface UpstreamHandoff {
  nodeId: string;
  summary: string;
}

export interface NodePromptParts {
  /** the node's per-step directive (YAML `task`); omitted when a persona agent runs on input alone */
  task?: string;
  /** the run-level input (the issue), from the ledger snapshot; omitted for `input: none` runs */
  input?: string;
  /** upstream handoff summaries, in dependency order; already sanitized/capped */
  upstream?: UpstreamHandoff[];
}

// ANSI CSI escape matcher built without embedding a literal ESC byte in source (ESC = char code 27).
const ANSI_CSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

/**
 * Strip an agent-authored summary down to safe, bounded content (codex 231 MAJOR-3).
 * Removes ANSI escape sequences and control chars (keeps \t and \n), trims, and caps the BYTE length
 * with a truncation marker. Never throws; a non-string yields "".
 */
export function sanitizeSummary(raw: unknown, cap: number = SUMMARY_CAP_BYTES): string {
  if (typeof raw !== "string") return "";
  const noAnsi = raw.replace(ANSI_CSI, "");
  let cleaned = "";
  for (const ch of noAnsi) {
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10) {
      cleaned += ch; // keep tab + newline
    } else if (c < 0x20 || c === 0x7f) {
      continue; // drop other C0 controls + DEL
    } else {
      cleaned += ch;
    }
  }
  const trimmed = cleaned.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= cap) return trimmed;
  // cap by bytes, then back off so we never split a UTF-8 multi-byte character
  const buf = Buffer.from(trimmed, "utf8");
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + TRUNCATION_MARKER;
}

const UPSTREAM_HEADER = "## Upstream context (agent-reported, untrusted)";
const INPUT_HEADER = "## Pipeline input";

/**
 * Compose a pipeline node's spawn prompt from its parts. Conditional sections are omitted entirely when
 * absent. EQUIVALENCE LOCK: `assembleNodePrompt({ task })` === `${task}\n\n${PIPELINE_NODE_GUIDANCE}`.
 */
export function assembleNodePrompt(parts: NodePromptParts): string {
  const sections: string[] = [];

  const task = parts.task?.trim();
  if (task) sections.push(task);

  const input = parts.input?.trim();
  if (input) sections.push(`${INPUT_HEADER}\n${input}`);

  const upstream = (parts.upstream ?? []).filter((u) => u.summary.trim().length > 0);
  if (upstream.length > 0) {
    const lines = upstream.map((u) => `- ${u.nodeId}: ${u.summary}`).join("\n");
    sections.push(`${UPSTREAM_HEADER}\n${lines}`);
  }

  sections.push(PIPELINE_NODE_GUIDANCE);
  return sections.join("\n\n");
}
