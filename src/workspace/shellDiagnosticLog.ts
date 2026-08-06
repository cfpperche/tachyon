import * as vscode from "vscode";

/**
 * t-74274c — the shell's durable failure log, and the summariser that makes a Zod refusal readable.
 *
 * WHY AN OUTPUT CHANNEL, and not a file under `.tachyon/`: the owner's own diagnosis of this bug
 * ended with a grep under `~/.vscode-server/data/logs/<session>/exthost<N>/output_logging_<stamp>`
 * that found no occurrence of `too_big`. VS Code backs every Output channel with a file in that
 * directory — the same run already leaves a `3-Tachyon IDE Browser.log` there from
 * `ide-browser-bridge/register.ts` — so this channel puts the record in the place the human had
 * ALREADY looked, rather than in a new place they would have to be told about. It is two clicks in
 * the UI (Output → Tachyon) and one grep from a terminal, which is the "without seven tool calls"
 * bar this task set.
 *
 * It deliberately does NOT reveal itself. A refresh that fails during a transient bridge restart
 * would otherwise steal the panel repeatedly; the status line names the channel instead, so opening
 * it stays the human's gesture.
 */
export const SHELL_DIAGNOSTIC_CHANNEL = "Tachyon";

/** A failure described for two surfaces with opposite budgets: one truncating line, and the record. */
export interface DescribedFailure {
  /** Front-loaded with the answer — a truncating status bar must not cut the field name away. */
  summary: string;
  /** Everything, for the durable channel. */
  detail: string;
}

interface RawIssue {
  path?: unknown;
  code?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

/**
 * Pull the Zod issues out of an error that may have crossed a process boundary.
 *
 * Both doors into `loadSidebar()` matter and they carry the SAME failure differently. In-process
 * (`legacySidebarTarget`) the projection's `ZodError` arrives intact, with `.issues`. Through the
 * daemon, `SidebarTarget.ts` turns the engine's reply into `new Error(result.message)` — the instance
 * is gone and only zod's JSON-stringified issue array survives, inside the message text. Reading
 * `.issues` alone would answer the door production does not use, which is exactly the shape of
 * failure this repository keeps paying for: a mechanism built for one caller, reached by another.
 *
 * No `instanceof ZodError` either: the daemon's zod is a different module instance, and this file
 * has no business importing zod to identify a shape it only reads.
 */
function extractIssues(error: unknown, message: string): RawIssue[] {
  const direct = (error as { issues?: unknown } | null | undefined)?.issues;
  if (Array.isArray(direct)) return direct as RawIssue[];
  const trimmed = message.trim();
  if (!trimmed.startsWith("[")) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    // A message that merely happens to be a JSON array is not an issue list. Requiring `path` keeps
    // this from dressing up unrelated payloads as validation findings.
    return parsed.every((entry) => !!entry && typeof entry === "object" && "path" in entry)
      ? (parsed as RawIssue[])
      : [];
  } catch {
    return [];
  }
}

/** `["fleet","agents",3,"focus","full"]` → `fleet.agents[3].focus.full`. */
export function formatIssuePath(path: unknown): string {
  if (!Array.isArray(path) || path.length === 0) return "(root)";
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc === "" ? String(segment) : `${acc}.${String(segment)}`;
  }, "");
}

function issueHeadline(issue: RawIssue): string {
  const code = typeof issue.code === "string" ? issue.code : "invalid";
  // "is", not ":" — every caller already ends its own title with a colon, and two in a row read as a
  // parse error rather than a sentence.
  return `${formatIssuePath(issue.path)} is ${code}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Collapse to one line without letting a 2400-character value ride along into the status bar. */
function oneLine(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Describe any failure for both surfaces; name the offending FIELD when the failure is a validation.
 *
 * The summary leads with the path because the surface it feeds truncates from the right. The owner's
 * report of this bug is the measurement: the status bar showed
 * `[ { "code": "too_big", "maximum": 2000, …` — every visible character spent on the shape of the
 * error and none on which field carried it, which cost a session of grepping.
 */
export function describeFailure(error: unknown): DescribedFailure {
  const message = messageOf(error);
  const issues = extractIssues(error, message);
  if (issues.length === 0) {
    const stack = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";
    return { summary: oneLine(message), detail: `${message}${stack}` };
  }

  const first = issues[0]!;
  const more = issues.length > 1 ? ` (+${issues.length - 1} more issue${issues.length > 2 ? "s" : ""})` : "";
  const detail = [
    `${issues.length} validation issue${issues.length === 1 ? "" : "s"}:`,
    "",
    ...issues.flatMap((issue, index) => {
      const { path, code, message: issueMessage, ...rest } = issue;
      const restKeys = Object.entries(rest).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`);
      return [
        `  ${index + 1}. ${formatIssuePath(path)}`,
        `      code: ${typeof code === "string" ? code : "(none)"}`,
        ...(typeof issueMessage === "string" ? [`      message: ${issueMessage}`] : []),
        ...restKeys,
        "",
      ];
    }),
  ].join("\n");
  return { summary: `${issueHeadline(first)}${more}`, detail };
}

let channel: vscode.OutputChannel | undefined;

/** Lazily open the shared channel — nothing is created in a window that never fails. */
function shellChannel(): vscode.OutputChannel {
  return (channel ??= vscode.window.createOutputChannel(SHELL_DIAGNOSTIC_CHANNEL));
}

/**
 * Write one failure to the durable channel and hand back the line for the transient surface.
 *
 * Returns the summary rather than notifying itself: the caller owns its own l10n'd wording, and a
 * logger that also decided how to shout would be two policies in one place.
 */
export function recordShellFailure(context: string, error: unknown): DescribedFailure {
  const described = describeFailure(error);
  const at = new Date().toISOString();
  shellChannel().appendLine(`[${at}] ${context}: ${described.summary}\n${described.detail}`);
  return described;
}

/** Tests only — the channel is a module singleton that must not leak between cases. */
export function __resetShellDiagnosticLog(): void {
  channel = undefined;
}
