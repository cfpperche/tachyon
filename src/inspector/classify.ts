/**
 * Pure session-name classification for the server inspector. Tachyon namespaces
 * every session it owns under the `tachyon-` prefix on its dedicated socket; the
 * second segment encodes the kind, followed by the 8-char workspace hash:
 *
 *   tachyon-ctl-<hash>              → control-mode engine anchor (internal)
 *   tachyon-cmd-<hash>-<command>…   → one-shot command run
 *   tachyon-rb-<hash>-<runbook>-<n> → runbook step
 *   tachyon-login-<hash>-<runtime>  → runtime login pane (t-2656d7)
 *   tachyon-<hash>-<name>           → agent or terminal (indistinguishable by name)
 *
 * No tmux access here — just string parsing, fully unit-tested.
 */

export type SessionKind = "anchor" | "command" | "runbook" | "login" | "session" | "unknown";

export interface ClassifiedSession {
  /** Kind inferred from the namespace segment. */
  kind: SessionKind;
  /** 8-char workspace hash, or undefined when it can't be parsed. */
  wsHash?: string;
  /** Human label for the entry within its workspace group (the name minus namespace plumbing). */
  label: string;
}

const HASH = /^[0-9a-f]{8}$/;

export function classifySession(session: string): ClassifiedSession {
  if (!session.startsWith("tachyon-")) {
    return { kind: "unknown", label: session };
  }
  const rest = session.slice("tachyon-".length);

  // tachyon-ctl-<hash>
  if (rest.startsWith("ctl-")) {
    const hash = rest.slice("ctl-".length);
    return { kind: "anchor", wsHash: HASH.test(hash) ? hash : undefined, label: "engine anchor" };
  }

  // tachyon-cmd-<hash>-<command>…
  if (rest.startsWith("cmd-")) {
    return namespaced("command", rest.slice("cmd-".length), session);
  }

  // tachyon-rb-<hash>-<runbook>-<n>
  if (rest.startsWith("rb-")) {
    return namespaced("runbook", rest.slice("rb-".length), session);
  }

  // tachyon-login-<hash>-<runtime> (t-2656d7) — a governed runtime login pane. Named here so the
  // inspector reports it as what it is instead of falling through to `unknown`.
  if (rest.startsWith("login-")) {
    return namespaced("login", rest.slice("login-".length), session);
  }

  // tachyon-<hash>-<name> (agent or terminal)
  return namespaced("session", rest, session);
}

/** Splits `<hash>-<label>` where the hash is an 8-char hex segment. */
function namespaced(kind: SessionKind, body: string, original: string): ClassifiedSession {
  const dash = body.indexOf("-");
  const hash = dash === -1 ? body : body.slice(0, dash);
  if (!HASH.test(hash)) {
    // Doesn't fit the namespace shape — surface the raw name rather than guess.
    return { kind: "unknown", label: original };
  }
  const label = dash === -1 ? original : body.slice(dash + 1);
  return { kind, wsHash: hash, label: label.length > 0 ? label : original };
}
