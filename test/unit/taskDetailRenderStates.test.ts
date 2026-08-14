import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";
import { loadWebviewModule, renderStatic } from "../helpers/staticPreact.js";
import type { TaskDetailVM } from "../../packages/webview-ui/src/webview/task-detail/messages.js";

/**
 * t-2f6cdd — the load-bearing deduction, measured instead of argued.
 *
 * The diagnosis of "Attention → Open opens an ENTIRELY BLANK Control" rests on one claim: *no
 * reachable state of the task-detail view renders nothing.* That is what moved the search above the
 * view — a blank surface cannot be a task-detail state, so the shell must never have mounted the
 * route — and a headless Dev Host then confirmed it exactly: `#root` held the SHELL's strings-less
 * `<EmptyState>` (pinned in the second describe below), with the detail nowhere in
 * it. `cockpitTaskDetailShellHandshake.test.ts` holds the fix itself.
 *
 * This file fixes the PREMISE, by rendering the real `App` from `src/` through SDD 479's static
 * Preact serializer and asserting each state paints something a human can see. Without it the
 * premise was only a reading of the source — and a reading is what the four hypotheses eliminated
 * in this task's journal were made of, none of which found the cause.
 *
 * Deliberately NOT a golden file: the point is the invariant (visible output in every state), not the
 * exact markup, so this must not break when the detail's layout is legitimately restyled.
 */
const APP_TSX = path.join(__dirname, "../../packages/webview-ui/src/webview/task-detail/App.tsx");

const DISPATCH = {
  updateTask: () => {},
  openTask: () => {},
  openStudio: () => {},
  refresh: () => {},
  approvePrototype: () => {},
  rejectPrototype: () => {},
  notePrototype: () => {},
};

function taskVm(overrides: Partial<TaskDetailVM> = {}): TaskDetailVM {
  return {
    wsHash: "abcd1234",
    id: "t-2f6cdd",
    tombstone: false,
    task: {
      id: "t-2f6cdd",
      title: "Attention Open renders the task",
      status: "active",
      author: "human",
      createdAt: "2026-07-27T21:00:00.000Z",
      updatedAt: "2026-07-27T21:00:00.000Z",
    },
    journal: [],
    deps: [],
    ...overrides,
  };
}

/** Text a human would actually read: tags and attributes stripped, whitespace collapsed. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

describe("t-2f6cdd — every task-detail render state paints something visible", () => {
  let App: (props: unknown) => unknown;

  beforeAll(async () => {
    // packageResolution: the detail's body renders through MarkdownView, whose import graph reaches
    // markdown-it and its plugins — real packages that bare `platform: "neutral"` cannot resolve.
    const mod = await loadWebviewModule(APP_TSX, { packageResolution: true });
    App = mod.App as (props: unknown) => unknown;
  });

  const render = (vm: TaskDetailVM | undefined): string =>
    renderStatic(App({ vm, errorSeq: 0, dispatch: DISPATCH }));

  it("renders the loading affordance when no vm has arrived yet", () => {
    const text = visibleText(render(undefined));
    expect(text).toContain("Loading task…");
  });

  it("renders a named not-found state when the vm carries no task", () => {
    const text = visibleText(render(taskVm({ task: undefined })));
    expect(text).toContain("t-2f6cdd");
    expect(text).toContain("never found on disk");
  });

  it("renders the last known state under a banner when the file is a tombstone", () => {
    const text = visibleText(render(taskVm({ tombstone: true })));
    expect(text).toContain("missing or unreadable");
    expect(text).toContain("Attention Open renders the task");
  });

  it("renders the task itself in the ordinary state", () => {
    const text = visibleText(render(taskVm()));
    expect(text).toContain("Attention Open renders the task");
    expect(text).toContain("t-2f6cdd");
  });

  /**
   * The invariant itself, stated once over the whole reachable state space. A blank Control tab is
   * therefore evidence that the view never received a vm AND never learned it should be loading —
   * which is exactly the host/client race the fix closes, not a task-detail state.
   */
  it("leaves no reachable state that renders nothing", () => {
    const states: Array<[string, TaskDetailVM | undefined]> = [
      ["no vm", undefined],
      ["vm without task", taskVm({ task: undefined })],
      ["tombstone", taskVm({ tombstone: true })],
      ["ordinary", taskVm()],
    ];
    for (const [name, vm] of states) {
      const text = visibleText(render(vm));
      expect(text, `${name} rendered no visible text`).not.toBe("");
    }
  });
});
