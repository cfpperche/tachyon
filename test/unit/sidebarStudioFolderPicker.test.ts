/**
 * t-be359b — the sidebar answers "which folder?" in OUR chrome for the "new …" studios.
 *
 * The production door has two halves and this file covers both, because a green test on either one
 * alone would prove nothing about the other:
 *   · the WEBVIEW half builds the candidate set from its own fleet model (`studioFolderItems`);
 *   · the HOST half must carry the chosen hash through to the command — dropping it is silent, and
 *     the symptom is the native quick pick opening anyway, which no typecheck would catch.
 *
 * The palette door is asserted here too: it sends NO hash and must still reach the native fallback,
 * because a surface-less caller has nowhere for a product picker to draw.
 */
import { describe, expect, it, beforeEach } from "vitest";
import * as vscode from "vscode";
import { __getExecutedCommands, __resetVscodeMock } from "../mocks/vscode.js";
import { SidebarPrototypeProvider } from "../../src/webview/SidebarPrototype.js";
import { studioFolderItems } from "../../packages/webview-ui/src/webview/sidebar/studioFolders.js";
import type { FleetVM } from "@tachyon/shared/sidebar/types.js";

const fleet = (hash: string, name: string, port = "42462"): FleetVM => ({
  folder: { hash, name },
  bridge: { port, connected: true },
  agents: [],
  terminals: [],
  pipelines: [],
  schedules: [],
  commands: [],
  runbooks: [],
  pins: [],
});

function fakeView(): { view: vscode.WebviewView; receive: (msg: unknown) => void } {
  const handlers: Array<(msg: unknown) => void> = [];
  let htmlText = "";
  const webview = {
    cspSource: "vscode-resource:",
    options: undefined,
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async () => true,
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      handlers.push(cb);
      return { dispose() {} };
    },
    get html() { return htmlText; },
    set html(value: string) { htmlText = value; },
  };
  const view = { webview, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewView;
  return { view, receive: (msg: unknown) => { for (const cb of handlers) cb(msg); } };
}

describe("t-be359b — studio folder choice draws in our chrome", () => {
  beforeEach(() => __resetVscodeMock());

  describe("webview half — the candidate set comes from the sidebar's own model", () => {
    it("offers one row per configured root, keyed by the hash the host resolves against", () => {
      const items = studioFolderItems([fleet("h1", "Tachyon", "42462"), fleet("h2", "Other", "42463")]);

      expect(items).toEqual([
        { id: "h1", label: "Tachyon", description: "Bridge :42462" },
        { id: "h2", label: "Other", description: "Bridge :42463" },
      ]);
    });

    it("drops a fleet with no folder ref instead of listing a row that cannot be named or resolved", () => {
      const anonymous = { ...fleet("h1", "Tachyon") };
      delete (anonymous as { folder?: unknown }).folder;

      expect(studioFolderItems([anonymous, fleet("h2", "Other")])).toEqual([
        { id: "h2", label: "Other", description: "Bridge :42462" },
      ]);
    });

    it("is what the component's 'more than one root' test reads, so a lone root asks nothing", () => {
      expect(studioFolderItems([fleet("h1", "Tachyon")]).length).toBe(1);
    });
  });

  describe("host half — the chosen hash reaches the command", () => {
    it("forwards the folder the webview picked, so the native list never opens", () => {
      const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => []);
      const { view, receive } = fakeView();
      provider.resolveWebviewView(view);

      receive({ type: "global", op: "studio:agents", hash: "h2" });

      expect(__getExecutedCommands()).toContainEqual({
        command: "tachyon.newAgentStudio",
        args: ["h2"],
      });
    });

    it("carries the hash for every studio op, not only the one that was wired first", () => {
      const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => []);
      const { view, receive } = fakeView();
      provider.resolveWebviewView(view);

      for (const op of ["studio:terminals", "studio:commands", "studio:runbooks", "studio:schedules"]) {
        receive({ type: "global", op, hash: "h7" });
      }

      const studioCalls = __getExecutedCommands().filter((c) => c.command.endsWith("Studio"));
      expect(studioCalls.map((c) => c.command)).toEqual([
        "tachyon.terminalStudio",
        "tachyon.commandStudio",
        "tachyon.runbookStudio",
        "tachyon.scheduleStudio",
      ]);
      for (const call of studioCalls) expect(call.args).toEqual(["h7"]);
    });

    it("sends undefined when the sidebar did not ask, so the palette door keeps its native fallback", () => {
      const provider = new SidebarPrototypeProvider(vscode.Uri.file("/extension"), () => []);
      const { view, receive } = fakeView();
      provider.resolveWebviewView(view);

      receive({ type: "global", op: "studio:agents" });

      expect(__getExecutedCommands()).toContainEqual({
        command: "tachyon.newAgentStudio",
        args: [undefined],
      });
    });
  });
});
