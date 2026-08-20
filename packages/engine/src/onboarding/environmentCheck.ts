/**
 * t-505f13 — the onboarding environment check, as a PURE projection.
 *
 * The probes are the product's own (`doctor()`, `detectInstalledClis()`, the engine-runtime Node
 * probe); what lives here is the shared ANSWER: facts in, checklist out, so every client that can
 * run the probes shows the same items, the same missing-what, and the same remedy — "the editor is
 * a client, not the door" applied to the check itself. The projection carries no I/O on purpose
 * (the shape of `initLogic.ts`, one layer over): the host composes the probes, the tests inject
 * facts.
 *
 * The vocabulary is the doctor pattern (flutter/brew doctor): every row states its own status, the
 * MISSING rows say what to do, and nothing has to leave the screen to resolve. The one state the
 * doctor pattern does not have is `info` — a row that is not checkable YET (credentials exist only
 * once an agent declares one) says so instead of pretending to have checked.
 */

import type { DoctorResult } from "../tmux/TmuxService.js";
import { ATTESTED_RUNTIMES } from "@tachyon/shared/runtime/attestedRuntimes.js";

export type EnvironmentItemId = "tmux" | "node" | "agent-cli" | "credential";
export type EnvironmentItemStatus = "ok" | "missing" | "info";

export interface EnvironmentItem {
  id: EnvironmentItemId;
  label: string;
  status: EnvironmentItemStatus;
  /** What was found — a version, a binary list, or the honest "not checkable yet". */
  detail: string;
  /** Present when status is "missing": what to do, in the reader's terms. */
  remedy?: string;
}

/** The engine-runtime Node fact. `source` is the path the engine would boot with. */
export type NodeCheckResult = { ok: true; source: string } | { ok: false; message: string };

export interface EnvironmentCheckInput {
  tmux: DoctorResult;
  node: NodeCheckResult;
  /** AI CLIs found on PATH (`detectInstalledClis`). */
  clis: string[];
  /** Present only when a Tachyon workspace exists: its credential inventory (may be empty). */
  credentials?: { storedCount: number; missing: Array<{ agent: string; name: string; provider: string; id: string }> };
}

export interface EnvironmentCheck {
  items: EnvironmentItem[];
  /** True when every REQUIRED item is ok — the gate the onboarding step shows as done. */
  ready: boolean;
}

/**
 * The remedy names all four attested runtimes, not a "preferred" one: the user who already has a
 * grok login should not be told to install claude. Order is the attestation list's own.
 */
export function buildEnvironmentCheck(input: EnvironmentCheckInput): EnvironmentCheck {
  const items: EnvironmentItem[] = [];

  items.push(input.tmux.ok
    ? { id: "tmux", label: "tmux", status: "ok", detail: input.tmux.version }
    // doctor()'s message already carries the per-platform install hint — reuse it verbatim rather
    // than re-authoring (and eventually contradicting) the copy the doctor command shows.
    : { id: "tmux", label: "tmux", status: "missing", detail: "not usable on this machine", remedy: input.tmux.message });

  items.push(input.node.ok
    ? { id: "node", label: "Node.js", status: "ok", detail: `engine runtime at ${input.node.source}` }
    : { id: "node", label: "Node.js", status: "missing", detail: "no real Node executable on PATH", remedy: input.node.message });

  const attested = input.clis.filter((cli) => (ATTESTED_RUNTIMES as readonly string[]).includes(cli));
  items.push(attested.length > 0
    ? { id: "agent-cli", label: "Agent runtime", status: "ok", detail: `on PATH: ${attested.join(", ")}` }
    : {
        id: "agent-cli",
        label: "Agent runtime",
        status: "missing",
        detail: "no attested agent CLI on PATH",
        remedy: `Install one of ${ATTESTED_RUNTIMES.join(", ")} and sign in — Tachyon runs agents through these CLIs, so without one no agent can start.`,
      });

  if (input.credentials) {
    const { storedCount, missing } = input.credentials;
    items.push(missing.length === 0
      ? { id: "credential", label: "Credentials", status: "ok", detail: storedCount === 0 ? "none declared yet" : `${storedCount} stored, none missing` }
      : {
          id: "credential",
          label: "Credentials",
          status: "missing",
          detail: missing.map((m) => `${m.provider}/${m.id} (required by ${m.agent})`).join("; "),
          remedy: `Store the missing ${missing.length === 1 ? "key" : "keys"} in the Keys tab — an agent cannot launch without its declared credentials.`,
        });
  } else {
    items.push({
      id: "credential",
      label: "Credentials",
      status: "info",
      detail: "checked when your first agent declares one",
    });
  }

  // `credential` is deliberately absent from the gate: it has an honest "info" state before any
  // agent exists, and gating on it would block the bootstrap on a check that cannot run yet.
  const ready = input.tmux.ok && input.node.ok && attested.length > 0;
  return { items, ready };
}
