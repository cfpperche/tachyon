import { describe, it, expect } from "vitest";
import {
  inWaitOutputScope,
  newOutputSince,
  waitForOutput,
  type WaitOutputCaptureSource,
} from "@tachyon/bridge/waitForOutput.js";

describe("newOutputSince", () => {
  it("returns the appended suffix for append-only growth", () => {
    expect(newOutputSince("a\nb\n", "a\nb\nc\n")).toBe("c\n");
  });

  it("returns empty when nothing changed", () => {
    expect(newOutputSince("a\nb\n", "a\nb\n")).toBe("");
  });

  it("anchors on the baseline's last line when the window rolled forward", () => {
    // baseline's first lines fell out of the bounded capture window, but its last line is still present.
    expect(newOutputSince("x\ny\nz\n", "y\nz\nnew1\nnew2\n")).toBe("new1\nnew2\n");
  });

  it("falls back to the whole capture when no anchor is found at all", () => {
    expect(newOutputSince("gone\n", "totally different\n")).toBe("totally different\n");
  });
});

describe("inWaitOutputScope", () => {
  const lineage = (parents: Record<string, string | undefined>) => ({ parentOf: (name: string) => parents[name] });

  it("allows self", () => {
    expect(inWaitOutputScope("watcher", "watcher", lineage({}))).toBe(true);
  });

  it("allows a direct child (caller spawned target)", () => {
    expect(inWaitOutputScope("coordinator", "child", lineage({ child: "coordinator" }))).toBe(true);
  });

  it("allows a sibling sharing the caller's own parent", () => {
    const l = lineage({ fixerA: "parent", fixerB: "parent" });
    expect(inWaitOutputScope("fixerA", "fixerB", l)).toBe(true);
  });

  it("refuses an unrelated agent with no lineage relation", () => {
    expect(inWaitOutputScope("watcher", "stranger", lineage({}))).toBe(false);
  });

  it("refuses when only the target (not the caller) has a parent link to a third party", () => {
    // target's parent is someone else entirely; caller has no parent at all.
    expect(inWaitOutputScope("watcher", "cousin", lineage({ cousin: "someone-else" }))).toBe(false);
  });
});

function fakeCapture(script: string[]): WaitOutputCaptureSource {
  let i = 0;
  return {
    capturePane: async () => script[Math.min(i++, script.length - 1)],
  };
}

describe("waitForOutput", () => {
  it("returns met:true with a bounded excerpt once new output matches", async () => {
    const source = fakeCapture(["baseline\n", "baseline\n", "baseline\nline1\nline2\nHIT ready\nline4\nline5\n"]);
    const result = await waitForOutput(source, "s", {
      match: "HIT",
      timeoutSec: 1,
      pollMs: 1,
      now: (() => {
        let t = 0;
        return () => t++;
      })(),
      sleep: async () => {},
    });
    expect(result.met).toBe(true);
    if (result.met) {
      expect(result.excerpt).toContain("HIT ready");
      expect(result.excerpt).not.toContain("baseline");
    }
  });

  it("returns met:false with a tail when the deadline passes with no match", async () => {
    const source = fakeCapture(["baseline\n"]);
    let t = 0;
    const result = await waitForOutput(source, "s", {
      match: "never",
      timeoutSec: 1,
      pollMs: 1,
      now: () => (t += 200),
      sleep: async () => {},
    });
    expect(result.met).toBe(false);
    if (!result.met) {
      expect(result.state).toBe("timeout");
      expect(result.tail).toBe("baseline\n");
    }
  });

  it("pre-existing (baseline) content never matches, even when identical to every later capture", async () => {
    const source = fakeCapture(["already here\n"]); // never changes — no new output ever arrives
    let t = 0;
    const result = await waitForOutput(source, "s", {
      match: "already here",
      timeoutSec: 1,
      pollMs: 1,
      now: () => (t += 200),
      sleep: async () => {},
    });
    expect(result.met).toBe(false);
  });

  it("matches literal substrings only — regex metacharacters in `match` are not special", async () => {
    // "(a+)+$" would be a catastrophic-backtracking pattern if treated as a regex source; here it must
    // only ever be compared as a literal substring, so a line containing it verbatim matches...
    const source = fakeCapture(["baseline\n", "baseline\nline has (a+)+$ literally\n"]);
    const result = await waitForOutput(source, "s", {
      match: "(a+)+$",
      timeoutSec: 1,
      pollMs: 1,
      now: (() => {
        let t = 0;
        return () => t++;
      })(),
      sleep: async () => {},
    });
    expect(result.met).toBe(true);
  });

  it("does not treat `match` as a regex — a pathological-looking pattern never matches unrelated text", async () => {
    const source = fakeCapture(["baseline\n"]);
    let t = 0;
    const result = await waitForOutput(source, "s", {
      match: "(a+)+$",
      timeoutSec: 1,
      pollMs: 1,
      now: () => (t += 200),
      sleep: async () => {},
    });
    expect(result.met).toBe(false);
  });

  it("caseInsensitive matches regardless of case without using regex", async () => {
    const source = fakeCapture(["baseline\n", "baseline\nREADY on port 3000\n"]);
    const result = await waitForOutput(source, "s", {
      match: "ready on port 3000",
      caseInsensitive: true,
      timeoutSec: 1,
      pollMs: 1,
      now: (() => {
        let t = 0;
        return () => t++;
      })(),
      sleep: async () => {},
    });
    expect(result.met).toBe(true);
  });

  it("without caseInsensitive, matching is case-sensitive", async () => {
    const source = fakeCapture(["baseline\n", "baseline\nREADY on port 3000\n"]);
    let t = 0;
    const result = await waitForOutput(source, "s", {
      match: "ready on port 3000",
      timeoutSec: 1,
      pollMs: 1,
      now: () => (t += 200),
      sleep: async () => {},
    });
    expect(result.met).toBe(false);
  });
});
