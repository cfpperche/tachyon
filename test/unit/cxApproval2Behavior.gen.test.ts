import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { Uri, __createdPanels, __getExecutedCommands, __resetVscodeMock } from "../mocks/vscode.js";
import {
  approvalRequestPath,
  buildApprovalRequest,
  readApprovalRequest,
  resolveApproval,
  writeApprovalRequest,
} from "../../src/bridge/approvalRequest.js";
import { buildApprovalViewModel } from "../../src/webview/approval/viewModel.js";
import { renderPrimer } from "../../src/bridge/primer.js";
import { ApprovalPanelManager } from "../../src/webview/ApprovalPanel.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

describe("container-generated delegation behavior", () => {
  beforeEach(() => __resetVscodeMock());

  it("the approval view routes resolution through the persistent engine with a verbatim payload and refuses a stale-session injection", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cx-approval-"));
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
    const toolsSource = fs.readFileSync(path.join(process.cwd(), "src/bridge/tools.ts"), "utf8");
    expect(toolsSource).toContain('"list_pending_approvals"');
    expect(toolsSource).not.toMatch(/registerTool\(\s*["'](?:resolve|approve|deny|decide)_?approval/i);
    expect(toolsSource).not.toMatch(/import\s*{[^}]*resolveApproval/);

    const injected: string[] = [];
    const resolved = await resolveApproval({
      workspaceRoot: ws,
      id: request.id,
      decision: "approved",
      resolvedBy: "vscode",
      currentSessionOwner: () => "child",
      inject: async (_session, text) => {
        injected.push(text);
        return { receipt: "typed" };
      },
    });
    expect(resolved.request.status).toBe("resolved");
    expect(injected).toEqual([`[tachyon] human approved your approval request ${request.id} — you may proceed accordingly`]);

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

  it("redirects legacy approval panel opens and revives into cockpit Approvals", () => {
    const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cx-approval-panel-"));
    const ws = {
      wsHash: "panel-truth",
      workspaceRoot: wsRoot,
      folderName: "repo",
    } as Workspace;
    const manager = new ApprovalPanelManager(Uri.file("/extension") as unknown as vscode.Uri, () => [ws]);
    manager.open(ws);

    expect(__createdPanels).toHaveLength(0);
    let disposed = false;
    manager.deserialize({
      dispose: () => { disposed = true; },
    } as unknown as vscode.WebviewPanel, {
      schemaVersion: 1,
      view: "tachyonApprovals",
      wsHash: "serialized-truth",
    });

    expect(disposed).toBe(true);
    expect(__getExecutedCommands()).toEqual([
      { command: "tachyon.openApprovals", args: ["panel-truth"] },
      { command: "tachyon.openApprovals", args: ["serialized-truth"] },
    ]);
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
