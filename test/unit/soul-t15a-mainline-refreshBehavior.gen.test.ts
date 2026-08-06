import { describe, it } from "vitest";
import { runNestedVitest } from "../helpers/nestedVitest.js";

describe("container-generated delegation behavior", () => {
  it("cmd:npx vitest run test/unit/soul-profile-t15a-implBehavior.gen.test.ts", () => {
    runNestedVitest("test/unit/soul-profile-t15a-implBehavior.gen.test.ts");
  }, 120_000);
});
