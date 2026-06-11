import { describe, it, expect } from "vitest";
import { Scheduler } from "../../src/schedule/Scheduler.js";
import { parseConfig, parseEvery, parseAt, type TachyonConfig } from "../../src/config/loadConfig.js";

const AGENTS = "agents:\n  claude: {cmd: claude}\ncommands:\n  test: {cmd: npm test}\nrunbooks:\n  ship:\n    steps: [test]\n";

function configOf(extra: string): TachyonConfig {
  const { config, errors } = parseConfig(AGENTS + extra);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

describe("interval/at parsing", () => {
  it("parseEvery handles m/h and rejects junk", () => {
    expect(parseEvery("30m")).toBe(1_800_000);
    expect(parseEvery("1h")).toBe(3_600_000);
    expect(parseEvery("2 h")).toBe(7_200_000);
    expect(parseEvery("0m")).toBeNull();
    expect(parseEvery("5s")).toBeNull();
    expect(parseEvery("noon")).toBeNull();
  });
  it("parseAt validates HH:MM", () => {
    expect(parseAt("09:00")).toEqual({ h: 9, m: 0 });
    expect(parseAt("23:59")).toEqual({ h: 23, m: 59 });
    expect(parseAt("24:00")).toBeNull();
    expect(parseAt("9:5")).toBeNull();
  });
});

describe("config: schedules", () => {
  it("parses every/run and at/spawn; validates the exclusivity rules", () => {
    const c = configOf("schedules:\n  hourly: {every: 1h, run: test}\n  standup: {at: \"09:00\", spawn: claude, instructions: summarize}\n");
    expect(c.schedules.hourly).toMatchObject({ every: "1h", run: "test" });
    expect(c.schedules.standup).toMatchObject({ at: "09:00", spawn: "claude", instructions: "summarize" });

    const both = parseConfig(AGENTS + "schedules:\n  x: {every: 1h, at: \"09:00\", run: test}\n");
    expect(both.errors[0]).toContain("exactly one of 'every' or 'at'");
    const neither = parseConfig(AGENTS + "schedules:\n  x: {every: 1h}\n");
    expect(neither.errors[0]).toContain("exactly one of 'run' or 'spawn'");
    const badRun = parseConfig(AGENTS + "schedules:\n  x: {every: 1h, run: ghost}\n");
    expect(badRun.errors[0]).toContain("declared command or runbook");
    const badSpawn = parseConfig(AGENTS + "schedules:\n  x: {at: \"09:00\", spawn: ghost}\n");
    expect(badSpawn.errors[0]).toContain("declared agent");
    const badEvery = parseConfig(AGENTS + "schedules:\n  x: {every: 5s, run: test}\n");
    expect(badEvery.errors[0]).toContain("30m");
  });
  it("run can reference a runbook; instructions only with spawn", () => {
    expect(configOf("schedules:\n  s: {every: 2h, run: ship}\n").schedules.s.run).toBe("ship");
    expect(parseConfig(AGENTS + "schedules:\n  s: {every: 1h, run: test, instructions: hi}\n").errors[0]).toContain("only valid with 'spawn'");
  });
});

function makeScheduler(extra: string) {
  let now = 1_000_000_000_000; // fixed epoch
  const fired: string[] = [];
  const sched = new Scheduler({
    getConfig: () => configOf(extra),
    now: () => now,
    onFire: (name) => { fired.push(name); },
  });
  return { sched, fired, advance: (ms: number) => (now += ms), setNow: (t: number) => (now = t) };
}

describe("Scheduler — every", () => {
  it("does not fire before the interval; fires after; re-anchors", () => {
    const { sched, fired, advance } = makeScheduler("schedules:\n  s: {every: 1h, run: test}\n");
    sched.activate();
    sched.tick(); // t0 — anchored, no fire
    expect(fired).toEqual([]);
    advance(59 * 60_000); sched.tick();
    expect(fired).toEqual([]);
    advance(2 * 60_000); sched.tick(); // > 1h since anchor
    expect(fired).toEqual(["s"]);
    advance(61 * 60_000); sched.tick();
    expect(fired).toEqual(["s", "s"]);
  });
  it("nothing fires before activate()", () => {
    const { sched, fired, advance } = makeScheduler("schedules:\n  s: {every: 1h, run: test}\n");
    advance(5 * 3_600_000); sched.tick();
    expect(fired).toEqual([]);
  });
});

describe("Scheduler — at", () => {
  // build a 'now' just before/after a target wall-clock time deterministically
  function atNoon(offsetMin: number) {
    const d = new Date(1_000_000_000_000);
    d.setHours(12, 0, 0, 0);
    return d.getTime() + offsetMin * 60_000;
  }
  it("fires once when the daily time is crossed, not again the same day", () => {
    const { sched, fired, setNow } = makeScheduler('schedules:\n  noon: {at: "12:00", run: test}\n');
    setNow(atNoon(-5)); sched.activate(); sched.tick();
    expect(fired).toEqual([]);                 // before noon
    setNow(atNoon(1)); sched.tick();
    expect(fired).toEqual(["noon"]);           // crossed
    setNow(atNoon(30)); sched.tick();
    expect(fired).toEqual(["noon"]);           // same day — no repeat
  });
  it("catchUp fires on activate when the time already passed today", () => {
    const { sched, fired, setNow } = makeScheduler('schedules:\n  noon: {at: "12:00", run: test, catchUp: true}\n');
    setNow(atNoon(120)); // 14:00, missed noon
    sched.activate();
    expect(fired).toEqual(["noon"]);
  });
  it("without catchUp, a missed time does NOT fire on activate", () => {
    const { sched, fired, setNow } = makeScheduler('schedules:\n  noon: {at: "12:00", run: test}\n');
    setNow(atNoon(120));
    sched.activate(); sched.tick();
    expect(fired).toEqual([]);
  });
});

describe("Scheduler — list/nextRun", () => {
  it("lists declared schedules with a future nextRun", () => {
    const { sched } = makeScheduler("schedules:\n  s: {every: 1h, run: test}\n");
    sched.activate();
    const list = sched.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("s");
    expect(list[0].nextRun).toBeGreaterThan(1_000_000_000_000);
  });
});
