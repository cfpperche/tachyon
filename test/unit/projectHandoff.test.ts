import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ProjectHandoffStore,
  parseNotes,
  pendingNotes,
  computeStaleness,
  parseCanonical,
  revisionOf,
  shouldRemindHandoff,
  advanceWatermark,
  HANDOFF_TEMPLATE,
} from "@tachyon/engine/handoff/ProjectHandoffStore.js";

describe("ProjectHandoff — pure helpers (spec 245)", () => {
  const note = (o: Record<string, unknown>) => JSON.stringify(o);

  it("parseNotes keeps valid rows, skips garbage/partial, coerces an unknown kind to 'next'", () => {
    const text = [
      note({ ts: "2026-01-01T00:00:00Z", agent: "a", kind: "completed", summary: "did x", evidence: ["f.ts"] }),
      "",
      "{bad json",
      note({ ts: "t", agent: "a" }), // missing summary → dropped
      note({ ts: "2026-01-02T00:00:00Z", agent: "b", kind: "weird", summary: "y" }), // unknown kind → "next"
    ].join("\n");
    const rows = parseNotes(text);
    expect(rows.map((r) => r.summary)).toEqual(["did x", "y"]);
    expect(rows[0].evidence).toEqual(["f.ts"]);
    expect(rows[1].kind).toBe("next");
  });

  it("pendingNotes = strictly newer than the canonical's last rewrite; all when never written", () => {
    const notes = parseNotes(
      [
        note({ ts: "2026-01-01T00:00:00Z", agent: "a", summary: "old" }),
        note({ ts: "2026-01-03T00:00:00Z", agent: "a", summary: "new" }),
      ].join("\n"),
    );
    expect(pendingNotes(notes, "2026-01-02T00:00:00Z").map((n) => n.summary)).toEqual(["new"]);
    expect(pendingNotes(notes, null).length).toBe(2);
  });

  it("computeStaleness covers all four states with the right precedence", () => {
    const base = { canonicalUpdatedAt: "2026-01-10T00:00:00Z", lastActivityAt: null as string | null, now: new Date("2026-01-10T01:00:00Z"), oldThresholdMs: 1000 * 60 * 60 * 24 };
    expect(computeStaleness({ ...base, pendingCount: 2 })).toBe("needs_distill"); // pending wins
    expect(computeStaleness({ ...base, pendingCount: 0, lastActivityAt: "2026-01-10T00:30:00Z" })).toBe("possibly_stale"); // activity after rewrite
    expect(computeStaleness({ ...base, pendingCount: 0, now: new Date("2026-02-01T00:00:00Z") })).toBe("old"); // aged out
    expect(computeStaleness({ ...base, pendingCount: 0 })).toBe("fresh");
    expect(computeStaleness({ ...base, pendingCount: 0, canonicalUpdatedAt: null })).toBe("fresh"); // nothing curated, nothing pending
  });

  it("shouldRemindHandoff (inc F) gates on activity-lag AND workspace cooldown", () => {
    const base = { curSeq: 100, anchorSeq: 0, lag: 25, lastNudgeAt: 0, now: 1_000_000, cooldownMs: 60_000 };
    expect(shouldRemindHandoff(base)).toBe(true); // 100 new records, never nudged → nudge
    expect(shouldRemindHandoff({ ...base, anchorSeq: 80 })).toBe(false); // only 20 new since anchor (< lag 25) → suppress
    expect(shouldRemindHandoff({ ...base, anchorSeq: 70 })).toBe(true); // 30 new ≥ lag → nudge
    expect(shouldRemindHandoff({ ...base, lastNudgeAt: 990_000 })).toBe(false); // 10s since last nudge < 60s cooldown → suppress
    expect(shouldRemindHandoff({ ...base, lastNudgeAt: 930_000 })).toBe(true); // 70s ≥ cooldown → nudge
    expect(shouldRemindHandoff({ ...base, cooldownMs: null })).toBe(false); // nudgeEvery: off → never
  });

  it("parseCanonical reads frontmatter+body, and treats a body-only file as all-body", () => {
    const withFm = "---\nversion: 1\nupdated_at: 2026-01-01T00:00:00Z\nupdated_by: human\n---\n\n## Current State\nx\n";
    const c1 = parseCanonical(withFm);
    expect(c1.meta.updated_at).toBe("2026-01-01T00:00:00Z");
    expect(c1.body).toContain("## Current State");
    const bodyOnly = "## Current State\nhand-authored\n";
    const c2 = parseCanonical(bodyOnly);
    expect(c2.body).toBe("## Current State\nhand-authored");
    expect(c2.revision).toBe(revisionOf("## Current State\nhand-authored"));
  });
});

describe("ProjectHandoffStore — fs (spec 245)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  function freshWs(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-handoff-"));
    dirs.push(ws);
    return ws;
  }

  it("cold start: readCanonical null, snapshot fresh + empty", () => {
    const store = new ProjectHandoffStore(freshWs());
    expect(store.readCanonical()).toBeNull();
    const snap = store.snapshot();
    expect(snap).toMatchObject({ exists: false, body: "", pendingCount: 0, staleness: "fresh" });
  });

  it("setCanonical writes (first write accepts any expected revision) + readCanonical round-trips with a revision", () => {
    const store = new ProjectHandoffStore(freshWs());
    const r = store.setCanonical(HANDOFF_TEMPLATE, undefined, "human");
    expect(r.ok).toBe(true);
    const c = store.readCanonical()!;
    expect(c.body).toContain("## Next Actions");
    expect(c.meta.updated_by).toBe("human");
    expect(c.revision).toBe((r as { revision: string }).revision);
    // default path is .tachyon/HANDOFF.md
    expect(store.canonicalPath.endsWith(path.join(".tachyon", "HANDOFF.md"))).toBe(true);
  });

  it("ensureCanonical creates once and never replaces an incumbent canonical", () => {
    const store = new ProjectHandoffStore(freshWs());
    expect(store.ensureCanonical(HANDOFF_TEMPLATE)).toMatchObject({ created: true });
    const revision = store.readCanonical()!.revision;
    store.setCanonical("human won the race", revision, "human");

    expect(store.ensureCanonical(HANDOFF_TEMPLATE)).toMatchObject({ created: false });
    expect(store.readCanonical()!.body).toBe("human won the race");
    expect(fs.readdirSync(path.dirname(store.canonicalPath)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("CAS: a rewrite with a stale revision is REJECTED (returns current body); with the right one, ACCEPTED", () => {
    const store = new ProjectHandoffStore(freshWs());
    store.setCanonical("v1 body", undefined);
    const cur = store.readCanonical()!;
    const stale = store.setCanonical("racing write", "deadbeefdeadbeef");
    expect(stale.ok).toBe(false);
    expect((stale as { current: string }).current).toBe("v1 body");
    const ok = store.setCanonical("v2 body", cur.revision);
    expect(ok.ok).toBe(true);
    expect(store.readCanonical()!.body).toBe("v2 body");
  });

  it("inc G — distilling clears notes only up to the declared watermark; a plain rewrite distills nothing", () => {
    let t = 0;
    const store = new ProjectHandoffStore(freshWs(), { now: () => new Date(2026, 0, 1, 0, 0, ++t) });
    const n1 = store.appendNote({ agent: "a", kind: "completed", summary: "first" }); // t=1
    store.appendNote({ agent: "b", kind: "blocked", summary: "second" }); // t=2
    // a plain body rewrite (NO distilledThrough) must NOT clear pending — distilling is explicit (codex BLOCK)
    store.setCanonical("just a body edit", undefined); // t=3
    expect(store.snapshot().pendingCount).toBe(2);
    // distill THROUGH n1's ts → only n1 clears; "second" (newer) stays pending
    store.setCanonical("distilled n1", store.readCanonical()!.revision, "agent", n1.ts); // t=4
    const snap = store.snapshot();
    expect(snap.pending.map((n) => n.summary)).toEqual(["second"]);
    expect(snap.staleness).toBe("needs_distill");
    expect(store.readNotes().length).toBe(2); // all rows retained in the lane
  });

  it("advanceWatermark (inc G, codex re-review) is forward-only + STRICT canonical ISO-UTC", () => {
    const W = "2026-01-02T00:00:00.000Z"; // canonical (the exact shape Date#toISOString writes note ts in)
    expect(advanceWatermark(W, undefined)).toBe(W); // omitted → preserve
    expect(advanceWatermark(W, "")).toBe(W); // "" → preserve
    expect(advanceWatermark(W, "not-a-date")).toBe(W); // malformed (throws) → preserve
    expect(advanceWatermark(W, "Tue, 01 Jan 2030 00:00:00 GMT")).toBe(W); // parseable but NON-canonical → preserve, never clear-too-much
    expect(advanceWatermark(W, "2026-01-03")).toBe(W); // date-only, not canonical ISO-UTC → preserve
    expect(advanceWatermark(W, "2026-01-03T00:00:00Z")).toBe(W); // missing millis → not canonical → preserve
    expect(advanceWatermark(W, "+010000-01-01T00:00:00.000Z")).toBe(W); // JS extended-year (round-trips but wrong shape, codex) → preserve
    expect(advanceWatermark(W, "2026-01-01T00:00:00.000Z")).toBe(W); // older canonical → no regress
    expect(advanceWatermark(W, "2026-01-03T00:00:00.000Z")).toBe("2026-01-03T00:00:00.000Z"); // newer canonical → advance
    expect(advanceWatermark(undefined, "2026-01-01T00:00:00.000Z")).toBe("2026-01-01T00:00:00.000Z"); // first distill from none
  });

  it("inc G — concurrent append during a distill is NOT silently dropped (codex BLOCK regression)", () => {
    let t = 0;
    const store = new ProjectHandoffStore(freshWs(), { now: () => new Date(2026, 0, 1, 0, 0, ++t) });
    const seen = store.appendNote({ agent: "a", summary: "seen at read" }); // t=1
    const snap = store.snapshot(); // distiller reads: pending=[seen], watermark to echo = seen.ts
    const watermark = snap.pending[snap.pending.length - 1].ts;
    store.appendNote({ agent: "b", summary: "appended during distill" }); // t=2 — AFTER the read, BEFORE the set
    // distiller writes, declaring it only folded `seen`
    store.setCanonical("distilled the seen note", undefined, "agent", watermark); // t=3
    const after = store.snapshot();
    expect(after.pending.map((n) => n.summary)).toEqual(["appended during distill"]); // the late note SURVIVES as pending
    expect(seen.ts).toBe(watermark);
  });

  it("config path override is honored (tachyon.yml handoff.path)", () => {
    const ws = freshWs();
    const store = new ProjectHandoffStore(ws, { canonicalRelPath: "docs/HANDOFF.md" });
    store.setCanonical("custom path", undefined);
    expect(fs.existsSync(path.join(ws, "docs", "HANDOFF.md"))).toBe(true);
  });
});
