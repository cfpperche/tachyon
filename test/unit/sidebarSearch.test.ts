import { describe, expect, it } from "vitest";
import { searchIndex, type FleetVM } from "@tachyon/shared/sidebar/types.js";

const baseFleet: FleetVM = {
  bridge: { port: "0", connected: true },
  agents: [],
  terminals: [],
  pipelines: [],
  schedules: [],
  commands: [],
  runbooks: [],
  pins: [],
};

describe("sidebar search index", () => {
  it("indexes pin tags as searchable keywords without changing the visible title", () => {
    const [pin] = searchIndex({
      ...baseFleet,
      pins: [{ id: "p-123abc", text: "Retire legacy flow", done: false, by: "human", tags: ["docs", "api"] }],
    });

    expect(pin).toMatchObject({ tab: "Pins", name: "Retire legacy flow", hint: "p-123abc · #docs #api" });
    const haystack = `${pin.name} ${pin.hint ?? ""} ${pin.keywords ?? ""} ${pin.rowKey ?? ""}`.toLowerCase();
    expect(haystack).toContain("p-123abc");
    expect(haystack).toContain("#docs");
    expect(haystack).toContain("api");
  });

  it("keeps a pin id in the row key so picking an id search result can find the rendered row", () => {
    const [pin] = searchIndex({
      ...baseFleet,
      pins: [{ id: "p-cafe42", text: "Discuss launch checklist", done: false, by: "human", tags: [] }],
    });

    expect(pin.name).toBe("Discuss launch checklist");
    expect(pin.rowKey).toBe("Discuss launch checklist p-cafe42");
  });
});
