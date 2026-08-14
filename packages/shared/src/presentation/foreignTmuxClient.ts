/**
 * t-edbe36 — measure a foreign tmux client co-attached to a session the Agent Pane owns.
 *
 * SessionViewportRegistry makes sure two of OUR viewports (pane | terminal) never share a
 * session. The one door left is a human `tmux attach` from their own shell: we cannot and must
 * not arbitrate that client. While it is co-attached, tmux sizes the window to the smallest
 * client and pads the larger one with `·`. The pane already survives that; this module only
 * CLASSIFIES the measurement so the pane can say why it looks broken.
 *
 * Measurement, not guesswork:
 * - while the pane is attached it owns exactly one tmux client;
 * - any extra row from `list-clients -t =<session>` is therefore not ours;
 * - when sizes differ, prefer the mismatched client (that is the geometry that produces the dots).
 * If we cannot tell with confidence, say so rather than alarm on a guess.
 */

export interface SessionClientInfo {
  /** tmux `#{client_name}` (usually a tty path). */
  name: string;
  width: number;
  height: number;
}

export type ForeignClientProbe =
  | { kind: "alone" }
  | {
      kind: "foreign";
      /** Geometry of the foreign client that is most likely driving the window size. */
      width: number;
      height: number;
      /** How many clients beyond our single pane client. */
      extraCount: number;
    }
  | {
      kind: "uncertain";
      /** Why we refuse to claim a foreign client. */
      reason: string;
      clientCount: number;
    };

/**
 * Parse `list-clients -F '#{client_name}\\t#{client_width}\\t#{client_height}'` stdout.
 * Malformed lines are dropped rather than invented.
 */
export function parseSessionClients(stdout: string): SessionClientInfo[] {
  const out: SessionClientInfo[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const tab = line.lastIndexOf("\t");
    if (tab <= 0) continue;
    const mid = line.lastIndexOf("\t", tab - 1);
    if (mid < 0) continue;
    const name = line.slice(0, mid);
    const width = Number.parseInt(line.slice(mid + 1, tab), 10);
    const height = Number.parseInt(line.slice(tab + 1), 10);
    if (!name || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) continue;
    out.push({ name, width, height });
  }
  return out;
}

/**
 * Classify clients on a session the Agent Pane currently holds.
 *
 * Call only while `SessionViewportRegistry.ownerOf(session) === "pane"` and the pane's attach
 * is alive — that is the "ours" side of the measurement. The registry never records client
 * names; ownership of the viewport plus client count is the distinction.
 */
export function probeForeignClients(
  clients: ReadonlyArray<SessionClientInfo>,
  our: { cols: number; rows: number },
): ForeignClientProbe {
  if (!Number.isFinite(our.cols) || !Number.isFinite(our.rows) || our.cols < 2 || our.rows < 1) {
    return { kind: "uncertain", reason: "pane size not measured yet", clientCount: clients.length };
  }
  if (clients.length === 0) {
    // Attached-but-no-clients is a race (list-clients between detach/attach) — do not alarm.
    return { kind: "alone" };
  }
  if (clients.length === 1) return { kind: "alone" };

  const mismatched = clients.filter((c) => c.width !== our.cols || c.height !== our.rows);
  if (mismatched.length === 0) {
    // Same size as us: no · padding, and we cannot tell which row is ours by geometry alone.
    // Still measured as multi-client; report one peer's size without inventing a mismatch.
    const peer = clients[0]!;
    return {
      kind: "foreign",
      width: peer.width,
      height: peer.height,
      extraCount: clients.length - 1,
    };
  }

  // tmux sizes the window to the smallest client; report that geometry so the message names the
  // force that is shrinking the view.
  const driver = mismatched.reduce((a, b) => {
    const aArea = a.width * a.height;
    const bArea = b.width * b.height;
    if (aArea !== bArea) return aArea < bArea ? a : b;
    if (a.width !== b.width) return a.width < b.width ? a : b;
    return a.height <= b.height ? a : b;
  });
  return {
    kind: "foreign",
    width: driver.width,
    height: driver.height,
    extraCount: clients.length - 1,
  };
}

/**
 * Reader-facing banner body. Written from the problem statement: temporary artifact, work safe,
 * clears when the foreign client leaves — no fight, no tmux jargon as the primary sentence.
 */
export function foreignClientBannerText(width: number, height: number): string {
  return (
    `Another terminal (${width}×${height}) is attached outside Tachyon. `
    + `The dotted padding is temporary and your work is safe — it clears when that client detaches.`
  );
}
