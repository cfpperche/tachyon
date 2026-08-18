import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  isWorkspaceQueryResultBoundToInput,
  isWorkspaceQueryV1,
  workspaceReviewDiffFileSuccessV1,
} from "@tachyon/engine/engine-service/protocol.js";
import { REVIEW_DIFF_QUERY_METHOD } from "@tachyon/engine/runtime-api/reviewProjection.js";

/**
 * t-1a76c5 / SDD 513 fatia 3 — the protocol arm fatia 1 named and fatia 2 did not add.
 *
 * Types stay in reviewProjection.ts. This file only proves the three doors now
 * carry them: protocol method, engine handler, control-client size arm.
 */
describe("t-1a76c5 — review.diff protocol wiring (SDD 513 fatia 3)", () => {
  it("names the same verb fatia 1 reserved", () => {
    expect(REVIEW_DIFF_QUERY_METHOD).toBe("review.diff");
    expect(isWorkspaceQueryV1({
      schemaVersion: 1,
      method: REVIEW_DIFF_QUERY_METHOD,
      input: { worktree: "hunkgrok", path: "src/a.ts", baseRef: "abc1234" },
    })).toBe(true);
  });

  it("binds a successful result to the queried worktree/path/baseRef", () => {
    const query = {
      schemaVersion: 1 as const,
      method: "review.diff" as const,
      input: { worktree: "hunkgrok", path: "src/gone.ts", baseRef: "55de2fc4" },
    };
    const result = workspaceReviewDiffFileSuccessV1({
      schemaVersion: 1,
      format: "unified",
      worktree: "hunkgrok",
      path: "src/gone.ts",
      status: "D",
      baseRef: "55de2fc4",
      currentLabel: "worktree",
      binary: false,
      hunks: [],
    });
    expect(result).toMatchObject({ method: "review.diff", status: "ok" });
    expect(isWorkspaceQueryResultBoundToInput(query, result)).toBe(true);
  });

  it("adds the method on the three doors fatia 1 located", () => {
    const protocol = fs.readFileSync("packages/engine/src/engine-service/protocol.ts", "utf8");
    const engine = fs.readFileSync("packages/engine/src/engine-service/engineService.ts", "utf8");
    const client = fs.readFileSync("packages/engine/src/engine-service/controlClient.ts", "utf8");
    expect(protocol).toContain('"review.diff"');
    expect(protocol).toContain("workspaceReviewDiffFileSuccessV1");
    const queryFn = engine.slice(
      engine.indexOf("async function executeWorkspaceQuery"),
      engine.indexOf("async function executeWorkspaceCommand"),
    );
    expect(queryFn).toContain('query.method === "review.diff"');
    expect(queryFn).toContain("projectReviewDiffFileV1");
    expect(queryFn).toContain("unifiedDiff");
    expect(client).toContain("REVIEW_DIFF_FILE_RESPONSE_MAX_BYTES");
    expect(client).toContain('request.query.method === "review.diff"');
  });
});
