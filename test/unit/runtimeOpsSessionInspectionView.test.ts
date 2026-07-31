import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import { buildRuntimeOpsSnapshot } from "../../src/runtimeOps/model.js";
import {
  isRuntimeOpsInspectSessionAction,
  runtimeOpsInspectSessionAction,
  runtimeOpsSessionInspectionMessage,
  type SessionInspectionState,
} from "../../src/webview/runtime-ops/messages.js";
import type { InspectedSession } from "../../src/runtimeOps/sessionInspection.js";

/**
 * t-283149 — the session inspector's UI, rendered from the real `App`.
 *
 * The panel exists because Tachyon injects CODE into someone's runtime — hooks that run commands and
 * write files, a status-line wrapper, MCP wiring, minted env — and no surface showed any of it. The
 * one time a human asked the runtime itself, Claude's `/hooks` answered "No hooks configured for this
 * event" while four Tachyon hooks were running.
 *
 * So the assertions here are about what a person can READ, not about markup: a panel that renders but
 * omits the `not-projected` rows, or that shows a file-only projection as if it were a live process,
 * fails at exactly the job it was built for.
 */
const APP_TSX = path.join(__dirname, "../../src/webview/runtime-ops/App.tsx");

const AGENT_KEY = "a1b2c3:claude";

const SNAPSHOT = buildRuntimeOpsSnapshot({
  generatedAt: "2026-07-30T12:00:00.000Z",
  detectedRuntimes: ["claude"],
  agents: [{
    workspaceKey: "a1b2c3", workspaceLabel: "tachyon", agentName: "claude", runtime: "claude",
    lastActivity: "2026-07-30T11:59:00.000Z", status: "running",
    attention: { state: "working", stale: false },
    model: { state: "available", value: "Opus 4.8", source: "runtime-profile" },
    resume: { state: "live", reason: "Agent process is currently live." },
    bridge: { currentGeneration: 7, boundGeneration: 7, wired: true, clientState: "ok" },
  }],
});

function session(overrides: Partial<InspectedSession> = {}): InspectedSession {
  return {
    agent: "claude",
    runtime: "claude",
    state: "live",
    command: ["claude", "--resume", "abc", "--bridge-token", "•••"],
    hooks: [
      { event: "SessionStart", command: "node session-owner-record.cjs", purpose: "records which agent owns this session", writes: ".tachyon/activity/session-owners.jsonl" },
      { event: "PreToolUse", command: "bash /home/goat/my-own-hook.sh" },
    ],
    settings: [
      { key: "permissions", value: "bypassPermissions", origin: "projected" },
      { key: "skipDangerousModePermissionPrompt", value: "true", origin: "host" },
      { key: "statusLine", value: "node wrapper.cjs", origin: "host", wraps: "bash ~/.claude/statusline-command.sh" },
      { key: "switchModelsOnFlag", value: "true", origin: "not-projected" },
    ],
    mcpServers: ["tachyon_bridge"],
    strictMcp: true,
    env: [{ key: "TACHYON_AGENT_NAME", value: "claude" }, { key: "TACHYON_BRIDGE_TOKEN", value: "•••" }],
    notExposed: [],
    ...overrides,
  };
}

/** Text a human would actually read: tags and attributes stripped, whitespace collapsed. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("t-283149 — the expanded agent row shows what Tachyon handed the runtime", () => {
  let App: (props: unknown) => unknown;

  beforeAll(async () => {
    const mod = await loadWebviewModule(APP_TSX);
    App = mod.App as (props: unknown) => unknown;
  });

  const render = (inspection?: SessionInspectionState): string =>
    renderStatic(App({
      snapshot: SNAPSHOT,
      onSetProviderObservation: () => {},
      sessionInspections: inspection ? { [AGENT_KEY]: inspection } : {},
      onToggleSessionInspection: () => {},
    }));

  it("shows nothing extra until a row is expanded", () => {
    // The inspection is a per-row read of a live process, not part of the fleet poll. A collapsed
    // fleet must not pay for it, and must not display a stale one either.
    expect(visibleText(render())).not.toContain("Hooks");
  });

  it("names every injected hook, its purpose and the file it writes", () => {
    const text = visibleText(render({ status: "ready", inspection: session() }));

    expect(text).toContain("SessionStart");
    expect(text).toContain("records which agent owns this session");
    expect(text).toContain(".tachyon/activity/session-owners.jsonl");
  });

  it("does not invent a purpose for a hook Tachyon did not author", () => {
    const text = visibleText(render({ status: "ready", inspection: session() }));

    expect(text).toContain("Not injected by Tachyon");
  });

  it("surfaces a global key the allowlist does not carry as NOT delivered", () => {
    // The row the whole panel is for. A key present in the person's config that never reaches the
    // agent is silent — no error, no warning, it simply does not act. That is how t-084b28 survived
    // three releases, and a panel that hid this row would have hidden the defect too.
    const text = visibleText(render({ status: "ready", inspection: session() }));

    expect(text).toContain("switchModelsOnFlag");
    expect(text).toContain("NOT delivered");
    expect(text).toContain("never reaches this agent");
  });

  it("renders a wrapped status line as one row that names what it wraps", () => {
    const html = render({ status: "ready", inspection: session() });

    expect(html.match(/statusLine/g)).toHaveLength(1);
    expect(visibleText(html)).toContain("wraps bash ~/.claude/statusline-command.sh");
  });

  it("says whether ambient MCP config is excluded, rather than leaving the list to imply it", () => {
    const strict = visibleText(render({ status: "ready", inspection: session() }));
    expect(strict).toContain("this list is exhaustive");

    const loose = visibleText(render({ status: "ready", inspection: session({ strictMcp: false }) }));
    expect(loose).toContain("Ambient MCP config is NOT excluded");
  });

  it("keeps a secret key visible while its value stays redacted", () => {
    const text = visibleText(render({ status: "ready", inspection: session() }));

    // "a bridge token is present" is the useful fact; its value never is.
    expect(text).toContain("TACHYON_BRIDGE_TOKEN");
    expect(text).toContain("•••");
  });

  it("distinguishes a live reading from a file-only projection", () => {
    const live = visibleText(render({ status: "ready", inspection: session() }));
    expect(live).toContain("Read from the running process");

    const stale = visibleText(render({ status: "ready", inspection: session({ state: "last-known", command: [] }) }));
    expect(stale).toContain("No live process");
  });

  it("states what a runtime does not expose instead of omitting it silently", () => {
    // parity.md's rule: a blank section reads as "nothing there", which is a different claim.
    const text = visibleText(render({
      status: "ready",
      inspection: session({ notExposed: ["hermes: Tachyon has no inspector for this runtime yet."] }),
    }));

    expect(text).toContain("Not shown here");
    expect(text).toContain("hermes");
  });

  it("shows the failure on the row when the host could not inspect", () => {
    // An engine predating `agent.session-inspection` refuses it by name. That is one row's problem,
    // not the section's — the rest of Runtime Ops keeps working.
    const text = visibleText(render({ status: "error", message: "This engine does not expose session inspection." }));

    expect(text).toContain("Session inspection unavailable");
    expect(text).toContain("does not expose session inspection");
    expect(text).toContain("Opus 4.8"); // the fleet table is untouched
  });

  it("says it is reading while the request is in flight", () => {
    expect(visibleText(render({ status: "loading" }))).toContain("Reading what claude was launched with");
  });
});

describe("t-283149 — the request/response pair the panel rides on", () => {
  it("accepts the action the panel posts", () => {
    expect(isRuntimeOpsInspectSessionAction(runtimeOpsInspectSessionAction("a1b2c3", "claude"))).toBe(true);
  });

  it("rejects anything else that reaches the same handler chain", () => {
    // Cockpit's listener is one chain of shape guards; a loose one steals another surface's message.
    expect(isRuntimeOpsInspectSessionAction({ type: "runtimeOpsInspectSession", workspaceKey: "a1b2c3" })).toBe(false);
    expect(isRuntimeOpsInspectSessionAction({ type: "runtimeOpsInspectSession", workspaceKey: "", agent: "claude" })).toBe(false);
    expect(isRuntimeOpsInspectSessionAction({ type: "runtimeOpsInspectSession", workspaceKey: "a1b2c3", agent: "claude", extra: 1 })).toBe(false);
    expect(isRuntimeOpsInspectSessionAction({ type: "runtimeOpsSetProviderObservation", provider: "claude", enabled: true })).toBe(false);
    expect(isRuntimeOpsInspectSessionAction(undefined)).toBe(false);
  });

  it("addresses each reply to the row that asked, so a late answer cannot land on another agent", () => {
    const ok = runtimeOpsSessionInspectionMessage(AGENT_KEY, { inspection: session() });
    expect(ok.agentKey).toBe(AGENT_KEY);
    expect(ok.error).toBeUndefined();

    const failed = runtimeOpsSessionInspectionMessage(AGENT_KEY, { error: "boom" });
    expect(failed.inspection).toBeUndefined();
    expect(failed.error).toBe("boom");
  });
});
