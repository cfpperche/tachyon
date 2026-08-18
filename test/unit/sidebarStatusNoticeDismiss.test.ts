/**
 * t-c820cb — the footer dismiss control reaches the store.dismiss() that already existed.
 *
 * Appear → dismiss → empty, then a later set still projects. Dismiss is not a channel switch.
 * No timer. Identity is the notice's `at`, so a stale click cannot hide a replacement.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSidebarFleet, type SidebarFleetSource } from "@tachyon/engine/sidebar/sidebarFleetService.js";
import { applySidebarMutation } from "@tachyon/engine/sidebar/sidebarMutationService.js";
import { StatusNoticeStore } from "@tachyon/engine/sidebar/statusNotice.js";
import {
  isSidebarMutationInputV1,
  isSidebarMutationResultIdentityV1,
} from "@tachyon/engine/runtime-api/sidebarCommands.js";
import type { DomainActionSource } from "@tachyon/engine/workspace/domainActions.js";
import type { StatusNotice } from "@tachyon/engine/sidebar/statusNotice.js";

const AT = "2026-08-17T12:00:00.000Z";
const AT_NEXT = "2026-08-17T12:01:00.000Z";

function fleetSource(notice?: () => StatusNotice | undefined): SidebarFleetSource {
  return {
    workspaceRoot: "/workspace",
    wsHash: "ws",
    folderName: "workspace",
    bridge: { port: 4317, url: "http://127.0.0.1:4317" },
    manager: {
      listAgents: async () => [],
      listTerminals: async () => [],
      defOf: () => ({ cmd: "claude", kind: "agent" }),
      resumeReadiness: async () => true,
      session: (name: string) => `tachyon-ws-${name}`,
    },
    ledger: { all: () => new Map(), get: () => undefined },
    tmux: { panePid: async () => { throw new Error("no pane"); } },
    worktrees: { currentBranch: async () => "main" },
    config: undefined,
    configFailure: undefined,
    handoffStore: { snapshot: () => ({ exists: false, staleness: "fresh", pendingCount: 0 }) },
    pinStore: { list: () => [] },
    proposals: { list: () => [] },
    scheduler: { list: () => [] },
    pipelines: { allRuns: () => [] },
    listPipelines: () => [],
    lastActivityAt: () => null,
    attentionOf: () => undefined,
    persistenceHookHealth: () => undefined,
    evidenceHandoff: async () => undefined,
    readConfigLkg: () => null,
    ...(notice ? { statusNotice: notice } : {}),
  } as unknown as SidebarFleetSource;
}

function mutationSource(store: StatusNoticeStore): DomainActionSource {
  return {
    dismissStatusNotice(at: string) {
      const current = store.get();
      if (!current || current.at !== at) return false;
      store.dismiss();
      return true;
    },
  } as unknown as DomainActionSource;
}

describe("t-c820cb — status notice dismiss through the sidebar mutation channel", () => {
  it("accepts only the notice's at as the mutation identity", () => {
    expect(isSidebarMutationInputV1({ action: "statusNotice.dismiss", id: AT })).toBe(true);
    expect(isSidebarMutationResultIdentityV1("statusNotice.dismiss", AT)).toBe(true);
    expect(isSidebarMutationInputV1({ action: "statusNotice.dismiss", id: "current" })).toBe(false);
    expect(isSidebarMutationInputV1({ action: "statusNotice.dismiss", id: "2026-08-17T12:00:00Z" })).toBe(false);
    expect(isSidebarMutationInputV1({ action: "statusNotice.dismiss", id: AT, extra: 1 })).toBe(false);
    expect(isSidebarMutationInputV1({ action: "notice.markRead", id: AT })).toBe(false);
  });

  it("a notice appears, dismiss empties the footer, and the next set still projects", async () => {
    const store = new StatusNoticeStore();
    store.set({ message: "Nothing to review", level: "info" }, () => new Date(AT));
    expect((await buildSidebarFleet(fleetSource(() => store.get()))).statusNotice).toEqual({
      message: "Nothing to review",
      level: "info",
      at: AT,
    });

    const changed: string[] = [];
    const first = await applySidebarMutation(
      mutationSource(store),
      { action: "statusNotice.dismiss", id: AT },
      (view) => changed.push(view),
    );
    expect(first).toEqual({ action: "statusNotice.dismiss", id: AT, changed: true });
    expect(changed).toEqual(["agents"]);
    expect((await buildSidebarFleet(fleetSource(() => store.get()))).statusNotice).toBeUndefined();

    store.set({ message: "run grok login first", level: "warn" }, () => new Date(AT_NEXT));
    expect((await buildSidebarFleet(fleetSource(() => store.get()))).statusNotice).toEqual({
      message: "run grok login first",
      level: "warn",
      at: AT_NEXT,
    });
  });

  it("a stale at leaves the replacement on screen", async () => {
    const store = new StatusNoticeStore();
    store.set({ message: "old", level: "info" }, () => new Date(AT));
    store.set({ message: "new", level: "error" }, () => new Date(AT_NEXT));

    const changed: string[] = [];
    const result = await applySidebarMutation(
      mutationSource(store),
      { action: "statusNotice.dismiss", id: AT },
      (view) => changed.push(view),
    );
    expect(result.changed).toBe(false);
    expect(changed).toEqual([]);
    expect((await buildSidebarFleet(fleetSource(() => store.get()))).statusNotice).toEqual({
      message: "new",
      level: "error",
      at: AT_NEXT,
    });
  });

  it("Workspace and the host route call the store dismiss that already existed", () => {
    const root = path.join(__dirname, "../..");
    const workspace = readFileSync(path.join(root, "packages/engine/src/workspace/Workspace.ts"), "utf8");
    expect(workspace).toMatch(/dismissStatusNotice\(at: string\): boolean/);
    expect(workspace).toContain("this.statusNoticeStore.dismiss()");
    expect(workspace).toContain("current.at !== at");

    const host = readFileSync(path.join(root, "apps/vscode-extension/src/webview/SidebarPrototype.ts"), "utf8");
    expect(host).toContain('case "statusNotice:dismiss": return this.mutateSidebar(ws, { action: "statusNotice.dismiss", id });');

    const app = readFileSync(path.join(root, "packages/webview-ui/src/webview/sidebar/App.tsx"), "utf8");
    expect(app).toContain('dispatch?.section("statusNotice:dismiss"');
  });

  it("the store, mutation, and footer still have no timer primitives", () => {
    const root = path.join(__dirname, "../..");
    for (const relative of [
      "packages/engine/src/sidebar/statusNotice.ts",
      "packages/engine/src/sidebar/sidebarMutationService.ts",
      "packages/engine/src/workspace/Workspace.ts",
      "packages/webview-ui/src/webview/sidebar/App.tsx",
    ]) {
      const body = readFileSync(path.join(root, relative), "utf8");
      if (relative.endsWith("App.tsx")) {
        const start = body.indexOf("function StatusNoticeFooter");
        const end = body.indexOf("export function App(");
        const footer = body.slice(start, end);
        expect(footer.length).toBeGreaterThan(200);
        expect(footer, relative).not.toMatch(/setTimeout|setInterval|expiresAt|\bttl\b|8_000|8000/);
        continue;
      }
      if (relative.endsWith("Workspace.ts")) {
        const start = body.indexOf("dismissStatusNotice(");
        const end = body.indexOf("markNoticeRead(", start);
        const method = body.slice(start, end);
        expect(method, relative).toContain("statusNoticeStore.dismiss");
        expect(method, relative).not.toMatch(/setTimeout|setInterval|expiresAt|\bttl\b|8_000|8000/);
        continue;
      }
      expect(body, relative).not.toMatch(/setTimeout|setInterval|expiresAt|\bttl\b|8_000|8000/);
    }
  });
});
