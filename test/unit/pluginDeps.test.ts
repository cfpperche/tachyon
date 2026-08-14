import { describe, it, expect } from "vitest";
import { satisfiesRange, dependencyState, dependencyStates } from "../../apps/vscode-extension/src/plugins/pluginDeps.js";
import type { Lockfile } from "@tachyon/engine/plugins/lockfile.js";

const lock = (plugins: Record<string, string>): Lockfile => ({
  schemaVersion: 1,
  plugins: Object.fromEntries(
    Object.entries(plugins).map(([name, version]) => [name, { name, version, runtimes: ["claude"], targets: [] } as never]),
  ),
});

describe("satisfiesRange (spec 276)", () => {
  it("caret: same major, >= base", () => {
    expect(satisfiesRange("2.1.0", "^2.1.0")).toBe(true);
    expect(satisfiesRange("2.5.3", "^2.1.0")).toBe(true);
    expect(satisfiesRange("2.0.9", "^2.1.0")).toBe(false); // below base
    expect(satisfiesRange("3.0.0", "^2.1.0")).toBe(false); // major bump
    expect(satisfiesRange("v2.2.0", "^2.1.0")).toBe(true); // leading v tolerated
  });
  it("tilde: same major+minor, >= base", () => {
    expect(satisfiesRange("2.1.4", "~2.1.0")).toBe(true);
    expect(satisfiesRange("2.2.0", "~2.1.0")).toBe(false);
  });
  it("exact + >= + wildcard", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
    expect(satisfiesRange("9.9.9", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("0.1.0", "*")).toBe(true);
    expect(satisfiesRange("0.1.0", "")).toBe(true);
  });
  it("fail-closed on garbage", () => {
    expect(satisfiesRange("not-a-version", "^1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", "garbage")).toBe(false);
  });
});

describe("dependencyState / dependencyStates", () => {
  it("missing when not in the lockfile", () => {
    expect(dependencyState({ name: "agent-browser", range: "^2.1.0" }, lock({}))).toMatchObject({ status: "missing", name: "agent-browser", range: "^2.1.0" });
    expect(dependencyState({ name: "x", range: "^1" }, undefined)).toMatchObject({ status: "missing" });
  });
  it("satisfied when present + in range; carries the installed version", () => {
    expect(dependencyState({ name: "agent-browser", range: "^2.1.0" }, lock({ "agent-browser": "2.3.0" }))).toEqual({ name: "agent-browser", range: "^2.1.0", status: "satisfied", installedVersion: "2.3.0" });
  });
  it("out-of-range when present but version doesn't satisfy", () => {
    expect(dependencyState({ name: "agent-browser", range: "^2.1.0" }, lock({ "agent-browser": "1.9.0" }))).toMatchObject({ status: "out-of-range", installedVersion: "1.9.0" });
  });
  it("dependencyStates maps all (direct only)", () => {
    const out = dependencyStates([{ name: "a", range: "^1" }, { name: "b", range: "^2" }], lock({ a: "1.5.0" }));
    expect(out.map((d) => d.status)).toEqual(["satisfied", "missing"]);
  });
});
