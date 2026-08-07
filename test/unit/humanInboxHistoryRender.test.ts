import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHumanInboxItemViewModel, buildHumanInboxViewModel } from "../../src/webview/human-inbox/viewModel.js";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";

const dispatch = new Proxy({}, { get: () => () => {} }) as never;

describe("Human Inbox resolved-history rendering (t-cede16)", () => {
  it("renders state, kind, compatible result, period and search controls", async () => {
    const { App } = await loadWebviewModule(path.resolve(__dirname, "../../src/webview/human-inbox/App.tsx"));
    const vm = buildHumanInboxViewModel({ folder: "tachyon", wsHash: "ws", approvals: [], validations: [] });
    const html = renderStatic((App as (props: unknown) => unknown)({ vm, dispatch }));

    expect(html).toContain('aria-label="State"');
    expect(html).toContain('aria-label="Type"');
    expect(html).toContain('aria-label="Result"');
    expect(html).toContain('label="Approvals"');
    expect(html).toContain('label="Validations"');
    expect(html).toContain('aria-label="Period"');
    expect(html).toContain('aria-label="Search inbox"');
  });

  it("renders resolved approval provenance verbatim and no decision controls", async () => {
    const { ItemApp } = await loadWebviewModule(path.resolve(__dirname, "../../src/webview/human-inbox/App.tsx"));
    const vm = buildHumanInboxViewModel({
      folder: "tachyon",
      wsHash: "ws",
      approvals: [{
        id: "a-audit1",
        requester: "claude",
        session: "tachyon-ws-claude",
        createdAt: "2026-08-07T10:00:00.000Z",
        payload: { reason: "retire an agent", proposedAction: "remove", risk: "durable", exactPrompt: "proceed?" },
        tampered: false,
        status: "resolved",
        resolution: {
          decision: "approved",
          resolvedAt: "2026-08-07T11:00:00.000Z",
          resolvedBy: "unattributed:vscode-command",
          injectedText: "fixed receipt",
        },
      }],
      validations: [],
    });
    const item = buildHumanInboxItemViewModel(vm, "approval", "a-audit1");
    const html = renderStatic((ItemApp as (props: unknown) => unknown)({ vm: item, dispatch }));

    expect(html).toContain("unattributed:vscode-command");
    expect(html).toContain("inbox-approval-resolution");
    expect(html).not.toContain("inbox-approve");
  });
});
