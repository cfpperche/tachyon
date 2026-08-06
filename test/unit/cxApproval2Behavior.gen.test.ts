import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { __resetVscodeMock } from "../mocks/vscode.js";
import {
  APPROVAL_CHANNEL_VSCODE_COMMAND,
  approvalRequestPath,
  composeFixedApprovalResponse,
  buildApprovalRequest,
  readApprovalRequest,
  resolveApproval,
  writeApprovalRequest,
} from "../../src/bridge/approvalRequest.js";
import { buildApprovalViewModel } from "../../src/webview/approval/viewModel.js";
import { renderPrimer } from "../../src/bridge/primer.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("container-generated delegation behavior", () => {
  beforeEach(() => __resetVscodeMock());

  it("the approval view routes resolution through the persistent engine with a verbatim payload and refuses a stale-session injection", async () => {
    const ws = makeTempDir("tachyon-cx-approval-");
    const request = buildApprovalRequest({
      id: "a-abc123",
      requester: "child",
      session: "tachyon-ws-child",
      createdAt: "2026-07-09T00:00:00.000Z",
      reason: "<b>reason</b>",
      proposedAction: "run exactly this",
      risk: "risk & consequence",
      exactPrompt: "<script>alert('x')</script>\nApprove?",
    });
    writeApprovalRequest(ws, request);

    const vm = buildApprovalViewModel({ workspaceRoot: ws, folder: "repo", wsHash: "hash" });
    expect(vm.approvals).toHaveLength(1);
    expect(vm.approvals[0]).toMatchObject({
      id: "a-abc123",
      requester: "child",
      session: "tachyon-ws-child",
      createdAt: "2026-07-09T00:00:00.000Z",
      tampered: false,
      payload: request.payload,
    });
    const appSource = fs.readFileSync(path.join(process.cwd(), "src/webview/approval/App.tsx"), "utf8");
    expect(appSource).toContain("<pre>{value}</pre>");
    expect(appSource).not.toContain("dangerouslySetInnerHTML");

    const extensionSource = fs.readFileSync(path.join(process.cwd(), "src/extension.ts"), "utf8");
    expect(extensionSource).toContain('vscode.commands.registerCommand("tachyon.resolveApproval"');
    expect(extensionSource).toContain('await extensionInvoke(ws, { action: "approval.resolve"');
    expect(extensionSource).not.toContain("await resolveApproval({");
    const serviceSource = fs.readFileSync(path.join(process.cwd(), "src/engine-service/extensionOperationService.ts"), "utf8");
    expect(serviceSource).toContain('case "approval.resolve"');
    expect(serviceSource).toContain("await resolveApproval({");
    // t-3b47ad — approval tools live under tools/human-approvals.ts; absence of a resolve tool is a whole-surface check.
    const toolsDir = path.join(process.cwd(), "src/bridge/tools");
    const toolsSource = [
      fs.readFileSync(path.join(process.cwd(), "src/bridge/tools.ts"), "utf8"),
      ...fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(toolsDir, f), "utf8")),
    ].join("\n");
    expect(toolsSource).toContain('"list_pending_approvals"');
    expect(toolsSource).not.toMatch(/registerTool\(\s*["'](?:resolve|approve|deny|decide)_?approval/i);
    expect(toolsSource).not.toMatch(/import\s*{[^}]*resolveApproval/);

    const injected: string[] = [];
    const resolved = await resolveApproval({
      workspaceRoot: ws,
      id: request.id,
      decision: "approved",
      resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND,
      currentSessionOwner: () => "child",
      inject: async (_session, text) => {
        injected.push(text);
        return { receipt: "typed" };
      },
    });
    expect(resolved.request.status).toBe("resolved");
    // t-86e59a — the injected line no longer opens by crediting a human for a decision no path can
    // attribute. It carries the state, the channel, and the limit of the check it points at.
    expect(injected).toEqual([
      composeFixedApprovalResponse(request, "approved", APPROVAL_CHANNEL_VSCODE_COMMAND),
    ]);
    expect(injected[0]).toContain(`approval request ${request.id} is APPROVED`);
    expect(injected[0]).toContain("Tachyon cannot prove a human made this decision");
    expect(injected[0]).not.toContain("[tachyon] human ");

    const tampered = buildApprovalRequest({
      id: "a-bad999",
      requester: "child",
      session: "tachyon-ws-child",
      reason: "original",
      proposedAction: "act",
      risk: "risk",
      exactPrompt: "prompt",
    });
    writeApprovalRequest(ws, tampered);
    const file = approvalRequestPath(ws, tampered.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.payload.exactPrompt = "tampered";
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const blockedVm = buildApprovalViewModel({ workspaceRoot: ws, folder: "repo", wsHash: "hash" });
    const blocked = blockedVm.approvals.find((item) => item.id === tampered.id);
    expect(blocked?.tampered).toBe(true);
    expect(blocked?.warning).toMatch(/payloadHash/);
    expect(() => readApprovalRequest(ws, tampered.id)).toThrow(/payloadHash/);

    const stale = buildApprovalRequest({
      id: "a-stale1",
      requester: "child",
      session: "tachyon-ws-child",
      reason: "stale",
      proposedAction: "inject",
      risk: "wrong pane",
      exactPrompt: "approve",
    });
    writeApprovalRequest(ws, stale);
    let staleInjected = false;
    await expect(resolveApproval({
      workspaceRoot: ws,
      id: stale.id,
      decision: "approved",
      currentSessionOwner: () => "other-agent",
      inject: async () => {
        staleInjected = true;
        return {};
      },
    })).rejects.toThrow(/refused: session 'tachyon-ws-child' now belongs to 'other-agent'.*original requester 'child'/);
    expect(staleInjected).toBe(false);

    expect(renderPrimer({ agentName: "child", parent: "parent" }).primer).toContain("confirm via get_approval_status(id) before acting");
  });

  it("contributes a localized open-approvals fallback without exposing the resolver", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      contributes: {
        commands: Array<{ command: string; title: string }>;
        menus?: { commandPalette?: Array<{ command: string; when?: string }> };
      };
    };
    const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.nls.json"), "utf8")) as Record<string, string>;
    const ptBr = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.nls.pt-br.json"), "utf8")) as Record<string, string>;

    expect(pkg.contributes.commands.find((entry) => entry.command === "tachyon.openApprovals")).toEqual({
      command: "tachyon.openApprovals",
      title: "%command.openApprovals%",
    });
    expect(pkg.contributes.commands.some((entry) => entry.command === "tachyon.resolveApproval")).toBe(false);
    expect(pkg.contributes.menus?.commandPalette?.some(
      (entry) => entry.command === "tachyon.openApprovals" && entry.when === "false",
    ) ?? false).toBe(false);
    expect(en["command.openApprovals"]).toBe("Tachyon: Open Human Approvals");
    expect(ptBr["command.openApprovals"]).toBe("Tachyon: Abrir aprovações humanas");
  });

  it("wires the persistent Workspace composition to the tested approval route", () => {
    const engineSource = fs.readFileSync(path.join(process.cwd(), "src/engine-service/engineService.ts"), "utf8");
    expect(engineSource).toMatch(
      /Workspace\.createDaemon\(canonicalRoot,\s*{[\s\S]*?onApprovalRequested:\s*\(approvalWorkspace, request\)\s*=>\s*{\s*routeHumanApprovalRequest\(host, approvalWorkspace\.wsHash, request\);/,
    );
  });
});
