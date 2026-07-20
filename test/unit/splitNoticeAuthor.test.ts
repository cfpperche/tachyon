import { describe, expect, it } from "vitest";
import { splitNoticeAuthor } from "../../src/sidebar/attentionStack.js";

// t-8aeaac follow-up — the notice CARD moves the author out of the message body into its own
// footer slot; this is the pure parse that recovers it from the persisted `message` string
// without any data-model change (taskNotificationPolicy's "… by <agent>: title" phrasing, and
// the generic notify tool's "[<agent>] …" prefix).
describe("splitNoticeAuthor", () => {
  it("recovers the actor from every task-event phrasing and rebuilds the body without it", () => {
    expect(splitNoticeAuthor("Task created by claude: A task")).toEqual({ body: "Task created: A task", author: "claude" });
    expect(splitNoticeAuthor("Task assigned to agent-b by agent-a: A task")).toEqual({ body: "Task assigned to agent-b: A task", author: "agent-a" });
    expect(splitNoticeAuthor("Task t-abc123 moved to landed by claude: A task")).toEqual({ body: "Task t-abc123 moved to landed: A task", author: "claude" });
    expect(splitNoticeAuthor("Task needs you — flagged by claude: A task")).toEqual({ body: "Task needs you — flagged: A task", author: "claude" });
    expect(splitNoticeAuthor("Task note added by claude: A task")).toEqual({ body: "Task note added: A task", author: "claude" });
  });

  it("recovers the actor from the generic notify tool's bracket prefix", () => {
    expect(splitNoticeAuthor("[grok] need a decision")).toEqual({ body: "need a decision", author: "grok" });
  });

  it("leaves an anonymous or pre-existing (author-less) message untouched", () => {
    expect(splitNoticeAuthor("Task created: A task")).toEqual({ body: "Task created: A task", author: undefined });
    expect(splitNoticeAuthor("tmux watchdog failed: no bus")).toEqual({ body: "tmux watchdog failed: no bus", author: undefined });
  });

  it("does not misfire on a title that merely contains the word 'by'", () => {
    expect(splitNoticeAuthor("Task created: fix caused by a race")).toEqual({ body: "Task created: fix caused by a race", author: undefined });
  });
});
