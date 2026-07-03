import { describe, expect, it } from "vitest";
import { searchIndex, type FleetVM } from "../../src/sidebar/types.js";

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
    expect(`${pin.name} ${pin.hint ?? ""} ${pin.keywords ?? ""}`.toLowerCase()).toContain("p-123abc");
    expect(`${pin.name} ${pin.hint ?? ""} ${pin.keywords ?? ""}`.toLowerCase()).toContain("#docs");
    expect(`${pin.name} ${pin.hint ?? ""} ${pin.keywords ?? ""}`.toLowerCase()).toContain("api");
  });
});
