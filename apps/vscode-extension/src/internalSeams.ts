import * as vscode from "vscode";
import type { ScheduleDef } from "@tachyon/engine/config/loadConfig.js";
import type { ExtensionCommandV1, ExtensionQueryV1, JsonValue } from "@tachyon/engine/runtime-api/extensionOperations.js";
import type { StudioSubmit } from "./webview/studioSubmit.js";

/**
 * t-4486eb — test-only `tachyon._*` commands. Built as a sibling of `dist/extension.js` and
 * loaded from `activate()` only when `TACHYON_TEST_SEAMS=1`, so the names never enter the
 * product bundle closure.
 *
 * This sibling DOES ship in the vsix, and that is deliberate rather than an oversight: the
 * screenshot runner and the editor-host suite drive an INSTALLED build, so the file has to be
 * present for them to load it. 5.9 KB against `extension.js`'s 2.7 MB — and in an installed build
 * without the variable nothing loads and nothing registers, so no other extension can invoke
 * `tachyon._spawn`: the command does not exist. Do not add a `DEV_ARTIFACTS` rule for it in
 * `scripts/ship-boundary.mjs` — pruning the bytes would break both consumers, and the surface was
 * already closed by the load gate rather than by the packager.
 */
export interface InternalSeamWorkspace {
  folderName: string;
  workspaceRoot: string;
  wsHash: string;
  bridgeUrl: string;
  studioSubmit(submit: StudioSubmit): string[] | undefined | Promise<string[] | undefined>;
  sidebar: { mutateSidebar(input: { action: "schedule.toggle-pause"; id: string }): unknown };
}

export interface InternalSeamDeps {
  byHash(hash?: string): InternalSeamWorkspace | undefined;
  workspaces(): InternalSeamWorkspace[];
  extensionQuery(ws: InternalSeamWorkspace, input: ExtensionQueryV1): Promise<JsonValue>;
  extensionInvoke(ws: InternalSeamWorkspace, input: ExtensionCommandV1): Promise<JsonValue>;
  refreshAll(): void;
  jsonObject(value: unknown, label: string): Record<string, JsonValue>;
}

function proposalSchedule(schedule: ScheduleDef): Extract<ExtensionCommandV1, { action: "proposal.create" }>["schedule"] {
  const catchUp = schedule.catchUp === undefined ? {} : { catchUp: schedule.catchUp };
  if (schedule.every && schedule.run) return { every: schedule.every, run: schedule.run, ...catchUp };
  if (schedule.at && schedule.run) return { at: schedule.at, run: schedule.run, ...catchUp };
  if (schedule.every && schedule.spawn) return { every: schedule.every, spawn: schedule.spawn, ...(schedule.instructions ? { instructions: schedule.instructions } : {}), ...catchUp };
  if (schedule.at && schedule.spawn) return { at: schedule.at, spawn: schedule.spawn, ...(schedule.instructions ? { instructions: schedule.instructions } : {}), ...catchUp };
  throw new Error("schedule proposal is incomplete");
}

export function registerInternalSeams(
  context: vscode.ExtensionContext,
  deps: InternalSeamDeps,
): void {
  const { byHash, workspaces, extensionQuery, extensionInvoke, refreshAll } = deps;
  context.subscriptions.push(
    vscode.commands.registerCommand("tachyon._agents", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "agents.list" }) : [];
    }),
    vscode.commands.registerCommand(
      "tachyon._spawn",
      (name: string, opts?: { cmd?: string; cwd?: string; instructions?: string; parent?: string }, hash?: string) => {
        const ws = byHash(hash);
        return ws ? extensionInvoke(ws, { action: "agent.spawn", agent: name, options: opts }) : undefined;
      },
    ),
    vscode.commands.registerCommand("tachyon._wait", (name: string, until: "idle" | "needs-input" | "dead", timeoutSec: number, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return { met: false, state: "gone" };
      return extensionQuery(ws, { action: "agent.wait", agent: name, until, timeoutSec });
    }),
    vscode.commands.registerCommand("tachyon._attention", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "attention.list" }) : {};
    }),
    vscode.commands.registerCommand("tachyon._pins", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "pins.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._pin", async (text: string, by?: string, done?: boolean, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return;
      await extensionInvoke(ws, { action: "pin.create", text, by: by ?? "claude", done: done ?? false });
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._upsertAgent", (submit: StudioSubmit, hash?: string) => byHash(hash)?.studioSubmit(submit)),
    vscode.commands.registerCommand("tachyon._schedules", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "schedules.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._proposals", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "proposals.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._propose", async (name: string, schedule: ScheduleDef, reason?: string, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return;
      await extensionInvoke(ws, { action: "proposal.create", name, schedule: proposalSchedule(schedule), by: "agent", ...(reason ? { reason } : {}) });
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._approveProposal", (id: string, hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionInvoke(ws, { action: "proposal.approve", id }) : undefined;
    }),
    vscode.commands.registerCommand("tachyon._rejectProposal", (id: string, hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionInvoke(ws, { action: "proposal.reject", id }) : undefined;
    }),
    vscode.commands.registerCommand("tachyon._togglePause", (name: string, hash?: string) => byHash(hash)?.sidebar.mutateSidebar({ action: "schedule.toggle-pause", id: name })),
    vscode.commands.registerCommand("tachyon._workspaces", () => workspaces().map((ws) => ({ folder: ws.folderName, root: ws.workspaceRoot, hash: ws.wsHash, bridge: ws.bridgeUrl }))),
    vscode.commands.registerCommand("tachyon._configHealth", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (!ws) return { ok: false as const, error: "no-workspace" };
      return extensionInvoke(ws, { action: "config.health" });
    }),
  );
}
