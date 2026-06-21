import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContinuityStore, parseBrief, serializeBrief, CONTINUITY_SOFT_CAP_BYTES } from "../../src/continuity/ContinuityStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-continuity-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const FIXED = new Date("2026-06-21T14:22:10.000Z");

describe("ContinuityStore (spec 241)", () => {
  let store: ContinuityStore;
  beforeEach(() => {
    fs.rmSync(path.join(root, ".tachyon"), { recursive: true, force: true });
    store = new ContinuityStore(root, () => FIXED);
  });

  it("cold start: read() returns null and no file/dir is created", () => {
    expect(store.read("claude")).toBeNull();
    expect(store.exists("claude")).toBe(false);
    expect(fs.existsSync(store.dir)).toBe(false);
  });

  it("write() stamps frontmatter (version/agent/updated_at/updated_by/status) + persists the body", () => {
    const res = store.write("claude", "# Current Goal\nship spec 241", { sourceActivitySeq: 1842 });
    expect(fs.existsSync(res.path)).toBe(true);
    expect(res.path).toContain(path.join(".tachyon", "continuity", "claude.md"));
    const brief = store.read("claude")!;
    expect(brief.meta).toMatchObject({
      version: 1,
      agent: "claude",
      updated_at: FIXED.toISOString(),
      updated_by: "agent",
      status: "active",
      source_activity_seq: 1842,
    });
    expect(brief.body).toContain("ship spec 241");
  });

  it("round-trips through disk (re-instantiate)", () => {
    store.write("claude", "# Next Steps\n1. test", { status: "blocked" });
    const reread = new ContinuityStore(root, () => FIXED).read("claude")!;
    expect(reread.meta.status).toBe("blocked");
    expect(reread.body).toContain("1. test");
  });

  it("preserves unknown/fork frontmatter fields across a rewrite (D7/D8)", () => {
    store.write("fork-1", "# Current Goal\ntangent", {
      status: "paused",
      extraMeta: { forked_from_agent: "claude", forked_from_session_id: "abc", custom_future_field: 7 },
    });
    store.write("fork-1", "# Current Goal\nupdated", {}); // a plain rewrite must NOT drop the extra fields
    const brief = store.read("fork-1")!;
    expect(brief.meta.forked_from_agent).toBe("claude");
    expect(brief.meta.forked_from_session_id).toBe("abc");
    expect(brief.meta.custom_future_field).toBe(7);
    expect(brief.meta.status).toBe("paused"); // status preserved when not re-specified
    expect(brief.body).toContain("updated");
  });

  it("rejects an invalid status", () => {
    expect(() => store.write("claude", "x", { status: "wat" as never })).toThrow(/invalid continuity status/);
  });

  it("read() throws on malformed frontmatter (never silently treats a corrupt brief as empty)", () => {
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.pathOf("claude"), "no frontmatter here", "utf8");
    expect(() => store.read("claude")).toThrow(/malformed|frontmatter/i);
    fs.writeFileSync(store.pathOf("claude"), "---\n: : bad yaml\n---\nbody", "utf8");
    expect(() => store.read("claude")).toThrow(/invalid YAML|frontmatter/i);
  });

  it("write() recovers from a corrupt prior file (readQuiet) and warns above the soft cap (D7)", () => {
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.pathOf("claude"), "garbage", "utf8");
    const big = "x".repeat(CONTINUITY_SOFT_CAP_BYTES + 10);
    const res = store.write("claude", big, {}); // must not throw despite the corrupt prior file
    expect(res.warning).toMatch(/soft cap/);
    expect(store.read("claude")!.body).toContain("x");
  });

  it("write() is atomic (no leftover .tmp files)", () => {
    store.write("claude", "# Current Goal\nok", {});
    const leftovers = fs.readdirSync(store.dir).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("serializeBrief/parseBrief are inverse", () => {
    const brief = { meta: { version: 1, agent: "a", updated_at: "t", updated_by: "agent" as const, status: "active" as const, source_activity_seq: 5 }, body: "# Current Goal\nhi" };
    const round = parseBrief(serializeBrief(brief), "a");
    expect(round.meta).toMatchObject(brief.meta);
    expect(round.body).toBe(brief.body);
  });
});
