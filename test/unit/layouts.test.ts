import { describe, it, expect } from "vitest";
import {
  PRESETS,
  leafCount,
  buildLayout,
  normalizeLayout,
  layoutsEqual,
  validateLayoutTree,
  captureToEntry,
} from "../../src/presentation/layoutLogic.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { upsertLayout } from "../../src/config/YamlConfigEditor.js";

const AGENTS = "agents:\n  claude: {cmd: claude}\n  shell: {cmd: bash}\n  dev: {cmd: sh}\n";

describe("layout presets and capacity", () => {
  it("every preset seats as many agents as it has leaves", () => {
    expect(leafCount(PRESETS["2up"].groups)).toBe(2);
    expect(leafCount(PRESETS["3up"].groups)).toBe(3);
    expect(leafCount(PRESETS["2x2"].groups)).toBe(4);
    expect(leafCount(PRESETS["rows-2"].groups)).toBe(2);
    expect(leafCount(PRESETS["rows-3"].groups)).toBe(3);
    expect(leafCount(PRESETS["main-left"].groups)).toBe(3);
    expect(leafCount(PRESETS["main-right"].groups)).toBe(3);
  });

  it("buildLayout applies yml sizes onto the preset's top level", () => {
    const layout = buildLayout({ grid: "2up", sizes: [0.7, 0.3], agents: ["a", "b"] });
    expect(layout.groups.map((g) => g.size)).toEqual([0.7, 0.3]);
    // preset defaults survive when no sizes given
    expect(buildLayout({ grid: "main-left", agents: ["a"] }).groups[0].size).toBe(0.65);
  });

  it("a custom captured tree wins over grid", () => {
    const tree = { orientation: 1 as const, groups: [{ size: 0.8 }, { size: 0.2 }] };
    expect(buildLayout({ layout: tree, agents: ["a"] })).toEqual(tree);
  });
});

describe("normalizeLayout (capture path)", () => {
  it("converts pixel sizes from getEditorLayout into proportions summing to 1", () => {
    const normalized = normalizeLayout({
      orientation: 0,
      groups: [{ size: 1200 }, { size: 400, groups: [{ size: 300 }, { size: 100 }] }],
    });
    expect(normalized.groups.map((g) => g.size)).toEqual([0.75, 0.25]);
    expect(normalized.groups[1].groups!.map((g) => g.size)).toEqual([0.75, 0.25]);
  });

  it("rounding drift lands on the last group so the level still sums to 1", () => {
    const normalized = normalizeLayout({ orientation: 0, groups: [{ size: 1 }, { size: 1 }, { size: 1 }] });
    const sizes = normalized.groups.map((g) => g.size!);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("levels without sizes stay size-free (equal split)", () => {
    const normalized = normalizeLayout({ orientation: 0, groups: [{}, {}] });
    expect(normalized.groups.every((g) => g.size === undefined)).toBe(true);
  });
});

describe("layoutsEqual (idempotent re-apply)", () => {
  it("tolerates small size drift, rejects structural difference", () => {
    const a = { orientation: 0 as const, groups: [{ size: 0.7 }, { size: 0.3 }] };
    expect(layoutsEqual(a, { orientation: 0, groups: [{ size: 0.72 }, { size: 0.28 }] })).toBe(true);
    expect(layoutsEqual(a, { orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] })).toBe(false);
    expect(layoutsEqual(a, { orientation: 1, groups: [{ size: 0.7 }, { size: 0.3 }] })).toBe(false);
    expect(layoutsEqual(a, { orientation: 0, groups: [{ size: 0.7, groups: [{}, {}] }, { size: 0.3 }] })).toBe(false);
  });
});

describe("validateLayoutTree", () => {
  it("accepts a sane tree; flags bad sums, partial sizes, tiny panes", () => {
    expect(validateLayoutTree({ orientation: 0, groups: [{ size: 0.6 }, { size: 0.4 }] }, "x")).toEqual([]);
    expect(validateLayoutTree({ orientation: 0, groups: [{ size: 0.6 }, { size: 0.6 }] }, "x")[0]).toContain("sum to 1");
    expect(validateLayoutTree({ orientation: 0, groups: [{ size: 0.6 }, {}] }, "x")[0]).toContain("all sibling");
    expect(validateLayoutTree({ orientation: 0, groups: [{ size: 0.99 }, { size: 0.01 }] }, "x")[0]).toContain("> 0.04");
  });
});

describe("config: layouts vocabulary + settings.layout", () => {
  it("parses new presets with sizes; validates count and sum", () => {
    const ok = parseConfig(AGENTS + "layouts:\n  main:\n    grid: main-left\n    sizes: [0.7, 0.3]\n    agents: [claude, shell, dev]\n");
    expect(ok.errors).toEqual([]);
    expect(ok.config!.layouts.main).toMatchObject({ grid: "main-left", sizes: [0.7, 0.3] });

    expect(parseConfig(AGENTS + "layouts:\n  bad:\n    grid: 2up\n    sizes: [0.7, 0.2]\n    agents: [claude]\n").errors[0]).toContain("sum to 1");
    expect(parseConfig(AGENTS + "layouts:\n  bad:\n    grid: 3up\n    sizes: [0.5, 0.5]\n    agents: [claude]\n").errors[0]).toContain("3 numbers");
  });

  it("custom layout tree parses; grid+layout together refused", () => {
    const ok = parseConfig(AGENTS + "layouts:\n  mine:\n    layout:\n      orientation: 0\n      groups: [{size: 0.7}, {size: 0.3}]\n    agents: [claude, shell]\n");
    expect(ok.errors).toEqual([]);
    expect(ok.config!.layouts.mine.layout!.orientation).toBe(0);

    expect(parseConfig(AGENTS + "layouts:\n  both:\n    grid: 2up\n    layout: {orientation: 0, groups: [{}]}\n    agents: [claude]\n").errors[0]).toContain("exactly one");
  });

  it("settings.layout must reference a declared layout", () => {
    const ok = parseConfig(AGENTS + "layouts:\n  pair: {grid: 2up, agents: [claude, shell]}\nsettings:\n  layout: pair\n");
    expect(ok.errors).toEqual([]);
    expect(ok.config!.settings.layout).toBe("pair");
    expect(parseConfig(AGENTS + "settings:\n  layout: ghost\n").errors[0]).toContain("unknown layout");
  });
});

describe("upsertLayout (Save Current Layout As…)", () => {
  const YML = AGENTS + "# my layouts\nlayouts:\n  pair: {grid: 2up, agents: [claude, shell]}\n";

  it("writes the captured entry; refuses duplicates unless overwrite", () => {
    const entry = { layout: { orientation: 0, groups: [{ size: 0.7 }, { size: 0.3 }] }, agents: ["claude", "shell"] };
    const { text } = upsertLayout(YML, "focus", entry);
    expect(text).toContain("# my layouts"); // comments preserved
    const parsed = parseConfig(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.config!.layouts.focus.agents).toEqual(["claude", "shell"]);

    expect(() => upsertLayout(text, "focus", entry)).toThrow("already exists");
    expect(parseConfig(upsertLayout(text, "focus", entry, true).text).errors).toEqual([]);
  });
});

describe("captureToEntry", () => {
  it("maps tab groups to agents in leaf order; refuses agent-less captures", () => {
    const raw = { orientation: 0, groups: [{ size: 900 }, { size: 300 }] };
    const captured = captureToEntry(raw, ["claude", undefined]);
    expect("error" in captured).toBe(false);
    if (!("error" in captured)) {
      expect(captured.agents).toEqual(["claude"]);
      expect(captured.layout.groups.map((g) => g.size)).toEqual([0.75, 0.25]);
    }
    expect(captureToEntry(raw, [undefined, undefined])).toEqual({ error: "no-agents" });
  });
});
