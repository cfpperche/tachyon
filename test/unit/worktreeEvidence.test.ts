import { describe, it, expect } from "vitest";
import {
  evidenceStale,
  viewEvidence,
  appendCapped,
  replaceVerifySet,
  summarizeEvidence,
  isSafeArtifactRef,
  EVIDENCE_SCHEMA_VERSION,
  VERIFY_PRODUCER,
  STEP_RESULT_KIND,
  type WorktreeEvidence,
  type Severity,
} from "../../src/worktree/evidence.js";

let seq = 0;
const ev = (e: Partial<WorktreeEvidence> = {}): WorktreeEvidence => ({
  schemaVersion: EVIDENCE_SCHEMA_VERSION,
  id: `id-${seq++}`,
  targetAgent: "feature-auth",
  producer: "claude",
  atCommit: "abc",
  // strictly increasing default timestamps so ordering is deterministic
  producedAt: `2026-06-27T00:00:${String(seq).padStart(2, "0")}Z`,
  kind: "advisory",
  severity: "info" as Severity,
  summary: "a note",
  ...e,
});

describe("worktree evidence — pure helpers (spec 273)", () => {
  describe("evidenceStale — HEAD-only (NOT dirty)", () => {
    it("fresh when atCommit equals HEAD", () => {
      expect(evidenceStale({ atCommit: "abc" }, "abc")).toBe(false);
    });
    it("stale when HEAD moved past atCommit", () => {
      expect(evidenceStale({ atCommit: "abc" }, "def")).toBe(true);
    });
    it("stale with no atCommit", () => {
      expect(evidenceStale({ atCommit: "" }, "abc")).toBe(true);
    });
    // the divergence from verify: a dirty worktree is NOT an input here — only HEAD matters.
  });

  describe("viewEvidence — newest-first + staleness annotation", () => {
    it("sorts newest-first and flags staleness against HEAD", () => {
      const a = ev({ id: "a", producedAt: "2026-06-27T00:00:01Z", atCommit: "abc" });
      const b = ev({ id: "b", producedAt: "2026-06-27T00:00:09Z", atCommit: "old" });
      const views = viewEvidence([a, b], "abc");
      expect(views.map((v) => v.id)).toEqual(["b", "a"]); // newest-first
      expect(views.find((v) => v.id === "a")!.stale).toBe(false);
      expect(views.find((v) => v.id === "b")!.stale).toBe(true); // atCommit "old" != HEAD
    });
  });

  describe("appendCapped — cap drops the OLDEST", () => {
    it("keeps everything under the cap", () => {
      const out = appendCapped([ev(), ev()], ev(), 100);
      expect(out).toHaveLength(3);
    });
    it("drops the oldest when over the cap", () => {
      const existing = Array.from({ length: 3 }, (_, i) => ev({ id: `e${i}`, producedAt: `2026-06-27T00:00:0${i}Z` }));
      const added = ev({ id: "new", producedAt: "2026-06-27T00:00:09Z" });
      const out = appendCapped(existing, added, 3);
      expect(out).toHaveLength(3);
      expect(out.map((r) => r.id)).not.toContain("e0"); // oldest dropped
      expect(out.map((r) => r.id)).toContain("new");
    });
  });

  describe("replaceVerifySet — dedup the built-in verify step-results", () => {
    const stepRec = (id: string) =>
      ev({ id, producer: VERIFY_PRODUCER, kind: STEP_RESULT_KIND, summary: `step ${id}` });

    it("replaces prior verify step-results, preserves non-verify evidence", () => {
      const existing = [
        ev({ id: "judg", producer: "claude", kind: "judgment", summary: "looks right" }),
        stepRec("old1"),
        stepRec("old2"),
      ];
      const fresh = [stepRec("new1"), stepRec("new2"), stepRec("new3")];
      const out = replaceVerifySet(existing, fresh);
      const ids = out.map((r) => r.id);
      expect(ids).toContain("judg"); // non-verify preserved
      expect(ids).not.toContain("old1"); // prior verify set gone
      expect(ids).not.toContain("old2");
      expect(ids).toEqual(expect.arrayContaining(["new1", "new2", "new3"]));
      expect(out.filter((r) => r.producer === VERIFY_PRODUCER)).toHaveLength(3); // exactly the new set
    });
  });

  describe("summarizeEvidence — mechanical, no privileged kind", () => {
    it("counts total/fresh/stale + by severity + latest N", () => {
      const records = [
        ev({ id: "1", severity: "error", kind: "judgment", summary: "bad", atCommit: "HEAD", producedAt: "2026-06-27T00:00:05Z" }),
        ev({ id: "2", severity: "warn", kind: "advisory", summary: "meh", atCommit: "old", producedAt: "2026-06-27T00:00:04Z" }),
        ev({ id: "3", severity: "info", kind: "step-result", summary: "ok", atCommit: "HEAD", producedAt: "2026-06-27T00:00:03Z" }),
      ];
      const s = summarizeEvidence(records, "HEAD", 2);
      expect(s.total).toBe(3);
      expect(s.fresh).toBe(2); // records 1 + 3 at HEAD
      expect(s.stale).toBe(1); // record 2 at "old"
      expect(s.bySeverity).toEqual({ info: 1, warn: 1, error: 1 });
      expect(s.latest).toHaveLength(2);
      expect(s.latest[0].summary).toBe("bad"); // newest-first
      // mechanical: it carries kind verbatim but does not RANK by it (a "judgment" gets no special slot)
      expect(s.latest.map((l) => l.kind)).toEqual(["judgment", "advisory"]);
    });
  });

  describe("isSafeArtifactRef — reject traversal/absolute", () => {
    it("accepts a contained relative ref", () => {
      expect(isSafeArtifactRef("shot.png")).toBe(true);
      expect(isSafeArtifactRef("screens/before.png")).toBe(true);
    });
    it("rejects absolute, traversal, empty, NUL, and windows-drive", () => {
      for (const bad of ["", "/etc/passwd", "../escape", "a/../../b", "C:\\x", "x\\..\\y", "a\0b"]) {
        expect(isSafeArtifactRef(bad)).toBe(false);
      }
    });
  });
});
