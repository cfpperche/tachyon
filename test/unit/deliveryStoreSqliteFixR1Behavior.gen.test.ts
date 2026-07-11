import { describe, expect, it } from "vitest";

describe("container-generated delegation behavior", () => {
  it("SQLite DeliveryStore migrates legacy JSON exactly once, refuses intent collisions, and fails closed on runtimes without node:sqlite", () => {
    expect.fail("delegation not implemented yet");
  });
});
