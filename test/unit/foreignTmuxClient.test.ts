import { describe, expect, it } from "vitest";
import {
  foreignClientBannerText,
  parseSessionClients,
  probeForeignClients,
} from "@tachyon/shared/presentation/foreignTmuxClient.js";

/**
 * t-edbe36 — measured classification of a foreign tmux client co-attached to the Agent Pane.
 *
 * Fail-before contract: with two clients of different sizes on one session, the probe must
 * report the foreign geometry (not invent a third size, not claim "alone"). With one client it
 * must stay quiet. Unparseable input must not become a false alarm.
 */

describe("parseSessionClients", () => {
  it("reads name + width × height from tab-separated list-clients lines", () => {
    const raw = [
      "/dev/pts/12\t220\t50",
      "/dev/pts/3\t80\t24",
      "",
      "garbage",
      "only\tone",
      "/dev/pts/9\t0\t24",
    ].join("\n");
    expect(parseSessionClients(raw)).toEqual([
      { name: "/dev/pts/12", width: 220, height: 50 },
      { name: "/dev/pts/3", width: 80, height: 24 },
    ]);
  });
});

describe("probeForeignClients (t-edbe36)", () => {
  const our = { cols: 220, rows: 50 };

  it("is alone when only our client is attached", () => {
    expect(
      probeForeignClients([{ name: "/dev/pts/1", width: 220, height: 50 }], our),
    ).toEqual({ kind: "alone" });
  });

  it("is alone when list-clients is empty (race, not an alarm)", () => {
    expect(probeForeignClients([], our)).toEqual({ kind: "alone" });
  });

  it("reports the smaller mismatched client when a foreign shell is co-attached", () => {
    // Measured case from the task: pane 220×50 + foreign 80×24 → dots on the larger view.
    const probe = probeForeignClients(
      [
        { name: "/dev/pts/12", width: 220, height: 50 },
        { name: "/dev/pts/3", width: 80, height: 24 },
      ],
      our,
    );
    expect(probe).toEqual({
      kind: "foreign",
      width: 80,
      height: 24,
      extraCount: 1,
    });
  });

  it("still reports foreign when multiple peers share a size smaller than ours", () => {
    const probe = probeForeignClients(
      [
        { name: "us", width: 220, height: 50 },
        { name: "a", width: 80, height: 24 },
        { name: "b", width: 80, height: 24 },
      ],
      our,
    );
    expect(probe.kind).toBe("foreign");
    if (probe.kind === "foreign") {
      expect(probe.width).toBe(80);
      expect(probe.height).toBe(24);
      expect(probe.extraCount).toBe(2);
    }
  });

  it("reports multi-client of matching size without inventing a geometry mismatch", () => {
    const probe = probeForeignClients(
      [
        { name: "a", width: 220, height: 50 },
        { name: "b", width: 220, height: 50 },
      ],
      our,
    );
    expect(probe).toMatchObject({ kind: "foreign", width: 220, height: 50, extraCount: 1 });
  });

  it("refuses to classify when the pane has not measured its own grid yet", () => {
    expect(
      probeForeignClients([{ name: "a", width: 80, height: 24 }], { cols: 0, rows: 0 }),
    ).toMatchObject({ kind: "uncertain" });
  });
});

describe("foreignClientBannerText", () => {
  it("names the size, says temporary, and says work is safe", () => {
    const text = foreignClientBannerText(80, 24);
    expect(text).toMatch(/80×24/);
    expect(text.toLowerCase()).toMatch(/temporary/);
    expect(text.toLowerCase()).toMatch(/safe/);
    // Must not read like an eviction or a fatal error.
    expect(text.toLowerCase()).not.toMatch(/kill|evict|lost|ended/);
  });
});
