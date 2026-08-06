import { describe, it } from "vitest";
import { runNestedVitest } from "../helpers/nestedVitest.js";

describe("container-generated delegation behavior", () => {
  it("spec 377 T15A transaction recovery and Studio trust closure", () => {
    runNestedVitest("test/unit/soul-t15a-correctionsBehavior.gen.test.ts");
  }, 120_000);
});
