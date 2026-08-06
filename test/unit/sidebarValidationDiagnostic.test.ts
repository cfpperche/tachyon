import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import * as vscode from "vscode";
import { __getOutputChannels, __getStatusBarMessages, __resetVscodeMock } from "../mocks/vscode.js";
import { SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import { initializeVsCodeNotifications } from "../../src/workspace/notify.js";
import { SHELL_DIAGNOSTIC_CHANNEL, __resetShellDiagnosticLog, describeFailure, formatIssuePath } from "../../src/workspace/shellDiagnosticLog.js";
import type { WorkspaceSidebarTarget } from "../../src/shell/SidebarTarget.js";

/**
 * t-74274c — the failure the owner actually hit, reproduced at the schema that produced it.
 *
 * `SIDEBAR_FOCUS_FULL_MAX` is 2000 and the projection nests the offending value at
 * `fleet.agents[N].focus.full`, so the issue this builds carries the SAME path shape the owner's
 * status bar refused to show. It is a genuine ZodError from a genuine `.max()` — not a hand-written
 * object that could agree with a formatter while disagreeing with zod.
 */
function sidebarTooBigError(): z.ZodError {
  const schema = z.object({
    schemaVersion: z.literal(1),
    fleet: z.object({
      agents: z.array(z.object({ focus: z.object({ full: z.string().max(2_000) }) })),
    }),
  });
  const agents = Array.from({ length: 4 }, () => ({ focus: { full: "ok" } }));
  agents[3] = { focus: { full: "x".repeat(2_438) } }; // the owner's measured length for grokprobe1
  const result = schema.safeParse({ schemaVersion: 1, fleet: { agents } });
  if (result.success) throw new Error("fixture no longer reproduces the too_big failure");
  return result.error;
}

function failingWorkspace(error: unknown): WorkspaceSidebarTarget {
  return {
    wsHash: "demohash",
    loadSidebar: async () => { throw error; },
  } as unknown as WorkspaceSidebarTarget;
}

function fakeView(): vscode.WebviewView {
  const webview = {
    cspSource: "vscode-resource:",
    options: undefined,
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async () => true,
    onDidReceiveMessage: () => ({ dispose() {} }),
    html: "",
  };
  return { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewView;
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function channelText(): string {
  return __getOutputChannels()
    .filter((channel) => channel.name === SHELL_DIAGNOSTIC_CHANNEL)
    .flatMap((channel) => channel.lines)
    .join("");
}

describe("t-74274c — a sidebar validation failure reaches disk with its Zod path", () => {
  beforeEach(() => {
    __resetVscodeMock();
    // The channel is a module singleton; without this it would keep appending to the array the mock
    // reset just dropped, and every case after the first would read an empty log.
    __resetShellDiagnosticLog();
    initializeVsCodeNotifications();
  });

  /**
   * TWO transports reach this one catch, and the owner's evidence only shows the second.
   *
   * In-process (`legacySidebarTarget`) the projection's ZodError arrives as itself. Through the
   * daemon (`workspaceSidebarTarget`) `SidebarTarget.ts` re-wraps it as `new Error(result.message)`,
   * which flattens the instance to a string that merely CONTAINS the issue JSON. A diagnostic that
   * reads `error.issues` would answer the first door and silently give up on the one production
   * actually used — so both are named here, and the test list is the door list.
   */
  const doors: Array<[string, () => unknown]> = [
    ["in-process — the projection's own ZodError", () => sidebarTooBigError()],
    ["across the daemon — re-wrapped as a plain Error by SidebarTarget", () => new Error(sidebarTooBigError().message)],
  ];

  for (const [door, build] of doors) {
    it(`names the overflowing field on disk (${door})`, async () => {
      const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [failingWorkspace(build())]);
      provider.resolveWebviewView(fakeView());
      await flushPromises();

      const logged = channelText();
      expect(logged, "no durable copy of the refusal was written").not.toBe("");
      // The whole point of the task: the PATH, which the status bar truncated away.
      expect(logged).toContain("fleet.agents[3].focus.full");
      expect(logged).toContain("too_big");
    });

    it(`names the overflowing field in the status bar too (${door})`, async () => {
      const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => [failingWorkspace(build())]);
      provider.resolveWebviewView(fakeView());
      await flushPromises();

      const status = __getStatusBarMessages().map((entry) => entry.text).join("\n");
      // A truncating surface gets the ANSWER, not the first 80 characters of a JSON array. The owner
      // burned a session's context on a grep the path answers in one second.
      expect(status).toContain("fleet.agents[3].focus.full");
      expect(status).toContain(SHELL_DIAGNOSTIC_CHANNEL);
      expect(status, "the raw issue JSON is back in the status bar").not.toContain('"code"');
    });
  }

  it("keeps the durable copy for a non-Zod failure as well", async () => {
    const provider = new SidebarPrototypeProvider(
      vscode.Uri.file("/extension"),
      () => [failingWorkspace(new Error("bridge socket closed"))],
    );
    provider.resolveWebviewView(fakeView());
    await flushPromises();

    // No path exists to report here, and inventing one would be worse than saying so. What must NOT
    // regress is that the failure still lands somewhere a human can read after the toast expires.
    expect(channelText()).toContain("bridge socket closed");
    expect(__getStatusBarMessages().map((entry) => entry.text).join("\n")).toContain("bridge socket closed");
  });
});

describe("describeFailure — the summariser on its own", () => {
  it("renders array indices as indices, so the path can be pasted into a reader", () => {
    expect(formatIssuePath(["fleet", "agents", 3, "focus", "full"])).toBe("fleet.agents[3].focus.full");
    expect(formatIssuePath([])).toBe("(root)");
    expect(formatIssuePath(undefined)).toBe("(root)");
  });

  it("leads with the first path and counts the rest, instead of printing every issue to a status bar", () => {
    const error = new Error(JSON.stringify([
      { code: "too_big", message: "too long", path: ["fleet", "pins", 0, "text"] },
      { code: "invalid_type", message: "expected string", path: ["fleet", "handoff"] },
      { code: "custom", message: "sidebar entity ids must be unique", path: [] },
    ]));
    expect(describeFailure(error).summary).toBe("fleet.pins[0].text is too_big (+2 more issues)");
    // …and the ones the line had no room for are all in the record, none silently dropped.
    const { detail } = describeFailure(error);
    expect(detail).toContain("3 validation issues");
    expect(detail).toContain("fleet.handoff");
    expect(detail).toContain("(root)");
  });

  it("does not dress a plain JSON array up as validation findings", () => {
    // A message that merely parses as an array is not an issue list. Without the `path` requirement
    // this would print "(root) is invalid" and hide the actual text the caller needs to read.
    const summary = describeFailure(new Error('["a","b"]')).summary;
    expect(summary).toBe('["a","b"]');
  });

  it("keeps a long non-Zod message off the status bar but whole in the record", () => {
    const long = "x".repeat(5_000);
    const { summary, detail } = describeFailure(new Error(long));
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(detail).toContain(long);
  });
});
