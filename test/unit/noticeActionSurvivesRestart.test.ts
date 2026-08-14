import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonEngineHost, type DaemonUiRequest } from "@tachyon/engine/workspace/DaemonEngineHost.js";
import {
  DURABLE_NOTICE_COMMANDS,
  restoreNoticeInbox,
  restoreNoticeRoute,
} from "@tachyon/engine/workspace/noticeInbox.js";
import { routeHumanInboxItem } from "@tachyon/engine/engine-service/engineService.js";
import { HUMAN_INBOX_KINDS } from "@tachyon/webview-ui/humanInbox/model";

/**
 * t-ee2f19 — a notice outlived its own button.
 *
 * The inbox row is persisted; the action was a closure, and a closure dies with the engine instance
 * that made it. So every extension-host reload — which on this project happens several times a day,
 * once per install — left rows whose text still said something needed you and whose only button read
 * "Open unavailable", pointing at items that opened fine by every other route.
 *
 * The fix records the DESTINATION as data. These tests hold the two halves that make that safe: the
 * route survives the round trip, and nothing outside the closed command list ever does.
 */

const roots: string[] = [];
const hosts: DaemonEngineHost[] = [];

afterEach(() => {
  for (const disposable of hosts.splice(0)) disposable.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function storage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-notice-restart-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "bundle"));
  const requested: DaemonUiRequest[] = [];
  return { root, storageRoot: path.join(root, "state"), requested };
}

/** A fresh host over the SAME storage — the closest thing to the reload this task is about. */
function host(storageRoot: string, requested: DaemonUiRequest[]) {
  const created = new DaemonEngineHost({
    storageRoot,
    mediaRoot: path.join(path.dirname(storageRoot), "bundle"),
    appVersion: "0.57.0",
    requestUi: async (request) => {
      requested.push(request);
      return null;
    },
  });
  hosts.push(created);
  return created;
}

/** Writes the inbox the way a previous engine instance left it behind. */
function seedState(storageRoot: string, rows: unknown[]): void {
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, "state.json"),
    JSON.stringify({ "attention.noticeInbox.v1": rows }),
  );
}

function persistedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "3f2a5c1e-7b8d-4e2f-9a1b-6c4d8e0f2a3b",
    message: "Saved Agent proposal sp-76db6e from 'claude'",
    level: "info",
    at: "2026-07-31T17:21:46.431Z",
    collapsedCount: 1,
    actions: [{
      id: "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      label: "Review",
      route: {
        command: "tachyon.openHumanInbox",
        args: ["b349073a", { kind: "saved-agent-proposal", id: "sp-76db6e" }],
      },
    }],
    ...overrides,
  };
}

describe("t-ee2f19 — a notice's destination survives the engine that raised it", () => {
  it("restores the route, and reports the action as live because pressing it now does something", () => {
    const [entry] = restoreNoticeInbox([persistedRow()]);

    expect(entry.actions[0].route).toEqual({
      command: "tachyon.openHumanInbox",
      args: ["b349073a", { kind: "saved-agent-proposal", id: "sp-76db6e" }],
    });
    // `actionsLive` drives the webview's "unavailable" rendering. It has always meant one thing —
    // pressing this does something — and a restored route means exactly that again.
    expect(entry.actionsLive).toBe(true);
  });

  it("keeps a route-less action inert, instead of inventing a destination for it", () => {
    // Restart an agent, resume the fleet, open a pane: real actions with no data form. They must go on
    // rendering as unavailable — guessing a route for them is how this fix would become a new defect.
    const row = persistedRow();
    delete (row.actions[0] as Record<string, unknown>).route;

    const [entry] = restoreNoticeInbox([row]);

    expect(entry.actions[0].route).toBeUndefined();
    expect(entry.actionsLive).toBe(false);
  });

  it("INVOKES the restored route after a restart — the effect, not just the rendering", () => {
    // The defect this closes is not that the button looked dead; it is that it WAS dead. This is the
    // only assertion that would notice a route restored, displayed as live, and then doing nothing.
    const { storageRoot, requested } = storage();
    seedState(storageRoot, [persistedRow()]);

    const restarted = host(storageRoot, requested);

    expect(restarted.listNoticeInbox()[0]?.actionsLive, "restored notice rendered as dead").toBe(true);
    return restarted.invokeNoticeAction(
      "3f2a5c1e-7b8d-4e2f-9a1b-6c4d8e0f2a3b",
      "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    ).then(() => {
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({
        kind: "execute-command",
        command: "tachyon.openHumanInbox",
        args: ["b349073a", { kind: "saved-agent-proposal", id: "sp-76db6e" }],
      });
    });
  });

  it("every Inbox kind records a route, not just the one that was reported", () => {
    // t-5ca73a was reported only for saved-agent-proposal and turned out to break all three. Iterating
    // the authority rather than the reported case is what would have caught that a day earlier.
    for (const kind of HUMAN_INBOX_KINDS) {
      const routes: Array<{ command: string; args: readonly unknown[] } | undefined> = [];
      const host = {
        t: (template: string, ...args: unknown[]) =>
          template.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)] ?? "")),
        notify: (_message: string, _level?: string, actions?: Array<{ route?: { command: string; args: readonly unknown[] } }>) => {
          for (const action of actions ?? []) routes.push(action.route);
        },
        executeCommand: async () => undefined,
      };

      routeHumanInboxItem(host, "b349073a", { kind, id: `id-${kind}`, message: `${kind} needs you` });

      expect(routes[0], `${kind} recorded no durable route`).toBeDefined();
      expect(DURABLE_NOTICE_COMMANDS, `${kind} routes somewhere the restore will reject`)
        .toContain(routes[0]!.command);
    }
  });
});

/**
 * t-ee2f19 — the half that keeps this from being a hole.
 *
 * A restored notice comes out of state.json, which is not a trusted input. Without the closed list,
 * this feature would mean "write a file, make the editor run a command". The list is checked on the
 * way in AND on the way out, and anything unrecognised degrades to the inert row it is today.
 */
describe("t-ee2f19 — a persisted notice cannot become a way to run arbitrary commands", () => {
  it("refuses a command outside the closed list", () => {
    expect(restoreNoticeRoute({ command: "workbench.action.terminal.sendSequence", args: ["rm -rf /"] }))
      .toBeUndefined();
    // Near-misses too: a Tachyon-looking name that is not on the list is still not on the list.
    expect(restoreNoticeRoute({ command: "tachyon.doctor", args: [] })).toBeUndefined();
  });

  it("refuses a malformed route rather than repairing it into something plausible", () => {
    expect(restoreNoticeRoute(undefined)).toBeUndefined();
    expect(restoreNoticeRoute({ command: "tachyon.openApprovals" })).toBeUndefined();
    expect(restoreNoticeRoute({ command: "tachyon.openApprovals", args: "b349073a" })).toBeUndefined();
    expect(restoreNoticeRoute({ command: "tachyon.openApprovals", args: [1, 2, 3, 4, 5] })).toBeUndefined();
  });

  it("drops a rejected route WITHOUT discarding the notice, which is still history worth keeping", () => {
    const row = persistedRow();
    (row.actions[0] as Record<string, unknown>).route = { command: "tachyon.evil", args: [] };

    const [entry] = restoreNoticeInbox([row]);

    expect(entry, "a bad route swallowed the whole notice").toBeDefined();
    expect(entry.message).toContain("sp-76db6e");
    expect(entry.actions[0].label).toBe("Review");
    expect(entry.actions[0].route).toBeUndefined();
    expect(entry.actionsLive).toBe(false);
  });

  it("refuses to EXECUTE a route that was tampered with in state.json, not merely to display it", () => {
    // The load-bearing direction. Rejecting the route at render time but honouring it at invoke time
    // would be the whole hole, dressed as a fix.
    const { storageRoot, requested } = storage();
    seedState(storageRoot, [persistedRow({
      actions: [{
        id: "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        label: "Review",
        route: { command: "workbench.action.terminal.sendSequence", args: ["rm -rf /"] },
      }],
    })]);

    const restarted = host(storageRoot, requested);

    return expect(restarted.invokeNoticeAction(
      "3f2a5c1e-7b8d-4e2f-9a1b-6c4d8e0f2a3b",
      "9c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    )).rejects.toThrow(/missing or already consumed/);
  });

  it("lists only navigation — an action with an EFFECT must not be re-armed from disk", () => {
    // Opening a view on something the human was already told about is safe to rebuild. Restarting an
    // agent or resuming a fleet is a different decision, and not one this mechanism gets to make.
    expect([...DURABLE_NOTICE_COMMANDS].sort()).toEqual([
      "tachyon.openApprovals",
      "tachyon.openControlTask",
      "tachyon.openHumanInbox",
    ]);
  });
});
