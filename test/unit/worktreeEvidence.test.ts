import { describe, it, expect } from "vitest";
import {
  evidenceStale,
  viewEvidence,
  appendCapped,
  summarizeEvidence,
  evidenceBadge,
  isSafeArtifactRef,
  EVIDENCE_SCHEMA_VERSION,
  type WorktreeEvidence,
  type Severity,
} from "@tachyon/engine/worktree/evidence.js";

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

  describe("evidenceBadge — slim VM indicator (warn/error are FRESH-only)", () => {
    it("returns undefined for none", () => {
      expect(evidenceBadge(undefined)).toBeUndefined();
      expect(evidenceBadge({ total: 0, fresh: 0, stale: 0, bySeverity: { info: 0, warn: 0, error: 0 }, freshBySeverity: { info: 0, warn: 0, error: 0 }, latest: [] })).toBeUndefined();
    });
    it("distils total/stale, and warn/error from FRESH counts (a stale error doesn't light the badge)", () => {
      expect(
        evidenceBadge({ total: 4, fresh: 2, stale: 2, bySeverity: { info: 1, warn: 1, error: 2 }, freshBySeverity: { info: 1, warn: 1, error: 0 }, latest: [] }),
      ).toEqual({ total: 4, stale: 2, warn: 1, error: 0 }); // total/stale from all; warn/error from fresh
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
