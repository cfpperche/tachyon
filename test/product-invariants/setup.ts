import { beforeEach, expect } from "vitest";

// Gate-owned runtime guard: every Product Invariant test must execute at least one assertion.
beforeEach(() => {
  expect.hasAssertions();
});
