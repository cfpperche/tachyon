import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";

const BASE = "agents:\n  a:\n    cmd: claude\n";

describe("task notification yaml settings (t-bae005)", () => {
  it("accepts the complete settings block", () => {
    const parsed = parseConfig(`${BASE}settings:\n  taskNotifications:\n    enabled: true\n    events: [created, awaitingHuman]\n    suppressOwnChanges: false\n    dedupeWindowMs: 12\n`);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config?.settings.taskNotifications).toEqual({ enabled: true, events: ["created", "awaitingHuman"], suppressOwnChanges: false, dedupeWindowMs: 12 });
  });

  it.each([
    ["enabled: yes", "enabled"],
    ["events: [created, nope]", "events"],
    ["dedupeWindowMs: -1", "dedupeWindowMs"],
    ["dedupeWindowMs: 1.5", "dedupeWindowMs"],
    ["unknown: true", "unknown key"],
  ])("rejects invalid task notification config: %s", (line, message) => {
    const parsed = parseConfig(`${BASE}settings:\n  taskNotifications:\n    ${line}\n`);
    expect(parsed.warnings.join("\n")).toContain(message);
  });
});
