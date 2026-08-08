import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";
import { TERMINAL_STRIPPED_AGENT_KEYS, upsertAgent } from "../../src/config/YamlConfigEditor.js";
import { toEntry, type FormState } from "../../src/webview/formLogic.js";
import { blankTerminalFields } from "../../src/webview/terminal-studio-shell/domain.js";

/**
 * t-b54ead — the Terminal Studio must never again offer a key the loader refuses for a terminal.
 *
 * The defect this closes: the form carried a "Git worktree isolation" section (worktree, branch,
 * setup commands, verify gate) since `aa99c066`, mirrored from Agent Studio together with its
 * footer-void layout fix. SDD 478 M6 later taught `parseAgentEntry` to refuse all four under
 * `terminals:`, and nobody re-read the form. What a human got was not a silent drop — t-48dd8d's
 * `mutateConfig` refuses to WRITE a file the loader would discard from — but a Save that FAILED,
 * with a message telling them to go create an agent instead.
 *
 * Two lists could drift apart here, so neither is written twice: the refusal list is MEASURED by
 * running the real parser over a real `terminals:` entry, and the writer's strip list is imported
 * from the writer. The invariant is asserted end-to-end through the production chain the Terminal
 * Studio actually uses — `toEntry` → `upsertAgent(…, "terminals")` → `parseConfig` — which is the
 * door `Workspace.studioSubmit` walks through. Watched fail on the pre-fix tree: the maximal-form
 * case produced four discards and a yml carrying all four keys.
 *
 * The source-level assertion at the bottom is the WEAK one and is here only as a cheap tripwire: it
 * proves text, not behaviour. `test/browser/terminalStudioNoAgentKeys.test.ts` is the real measure
 * of what the form offers — it reads the shipped bundle's DOM.
 */

/** A value the loader accepts for this key on an AGENT, so a refusal can only be about the kind. */
const AGENT_VALID_VALUES: Record<string, unknown> = {
  kind: "terminal",
  instructions: "you are a reviewer",
  soul: true,
  selfEvolution: { enabled: true },
  worktree: true,
  branch: "feature/x",
  worktreeSetup: "npm ci",
  verify: "npm test",
};

/** Declare `key` on a `terminals:` entry and report every discard the loader raises for it. */
function terminalDiscardsFor(key: string): string[] {
  const parsed = parseConfig(JSON.stringify({ terminals: { probe: { cmd: "npm run dev", [key]: AGENT_VALID_VALUES[key] } } }));
  return parsed.discarded.filter((message) => message.includes(`'${key}'`) || message.includes(`.${key}:`));
}

/**
 * Every form field at a NON-default value. Written out rather than generated so each value is one the
 * loader would really accept, and pinned to `blankTerminalFields()`'s key set below — a new FormState
 * field cannot be added without this test forcing someone to decide what a terminal does with it.
 */
const MAXIMAL_TERMINAL_FORM: FormState = {
  name: "dev",
  cmd: "npm run dev",
  kind: "terminal",
  instructions: "you are a reviewer",
  soul: true,
  selfEvolution: true,
  role: "coder",
  watch: "src/**, package.json",
  steps: "npm test",
  cwd: "apps/web",
  autostart: true,
  restartOnCrash: true,
  attention: true,
  worktree: true,
  branch: "feature/x",
  worktreeSetup: "npm ci\nnpm run build",
  verify: "npm test",
  isolate: true,
  schedTiming: "at",
  schedEvery: "30m",
  schedAt: "10:00",
  schedAction: "spawn",
  schedTarget: "reviewer",
  catchUp: true,
};

describe("t-b54ead — a terminal entry the Studio writes carries no agent-only key", () => {
  it("every key the writer strips is one the loader really refuses for a terminal", () => {
    // The danger of a strip list is the opposite mistake: dropping a key a terminal may legitimately
    // carry. Measured against the parser rather than against a second copy of the list.
    for (const key of TERMINAL_STRIPPED_AGENT_KEYS) {
      expect(terminalDiscardsFor(key), `loader accepts '${key}' on a terminal — the writer must not strip it`).not.toEqual([]);
    }
  });

  it("the maximal terminal form covers every FormState field", () => {
    const blank = blankTerminalFields();
    expect(Object.keys(MAXIMAL_TERMINAL_FORM).sort()).toEqual(Object.keys(blank).sort());
    const maximal = MAXIMAL_TERMINAL_FORM as unknown as Record<string, unknown>;
    const blankMap = blank as unknown as Record<string, unknown>;
    const unchanged = Object.keys(blank).filter((k) => k !== "kind" && maximal[k] === blankMap[k]);
    expect(unchanged, "these fields are still at their blank value — the maximal form proves nothing about them").toEqual([]);
  });

  it("saving a maximal terminal form produces a config the loader discards nothing from", () => {
    const created = upsertAgent(undefined, "dev", toEntry(MAXIMAL_TERMINAL_FORM), undefined, "terminals");
    const parsed = parseConfig(created.text);
    expect(parsed.errors).toEqual([]);
    // The whole point: the write path cannot emit a key the read path throws away.
    expect(parsed.discarded).toEqual([]);
    for (const key of TERMINAL_STRIPPED_AGENT_KEYS) expect(created.text).not.toContain(`${key}:`);
    // What a terminal legitimately keeps still survives the strip.
    expect(parsed.config?.agents.dev).toMatchObject({ cmd: "npm run dev", cwd: "apps/web", autostart: true, restart: "on-crash", kind: "terminal" });
  });

  it("editing an ALREADY-polluted terminal rewrites the entry without the refused keys", () => {
    // Nothing migrates a tachyon.yml that already carries these keys — removing a form control does
    // not edit anyone's file. This is what the product does with one: the loader discards the four
    // with a named warning at every load and the terminal itself runs, and the first edit-and-save
    // through Terminal Studio rewrites the entry clean, because `upsertAgent` replaces it whole.
    const existing = "terminals:\n  dev:\n    cmd: npm run dev\n    worktree: true\n    branch: feature/x\n    worktreeSetup: npm ci\n    verify: npm test\n  api:\n    cmd: npm run api\n";
    const before = parseConfig(existing);
    expect(before.errors).toEqual([]);
    expect(before.discarded).toHaveLength(4);
    expect(before.config?.agents.dev).toMatchObject({ cmd: "npm run dev", kind: "terminal" });

    const reopened = { ...blankTerminalFields(), name: "dev", cmd: "npm run dev" };
    const rewritten = upsertAgent(existing, "dev", toEntry(reopened), "dev", "terminals");
    expect(parseConfig(rewritten.text).discarded).toEqual([]);
    expect(rewritten.text).not.toContain("worktree");
    expect(rewritten.text).toContain("api:");
  });

  it("the Terminal Studio shell binds no control to a refused key (tripwire; the browser suite measures the DOM)", () => {
    // Comments stripped first: this file's own doc comment NAMES the removed section and the four
    // keys, which is the point of it. A tripwire that trips on the explanation for its own existence
    // teaches the next person to delete the explanation.
    const src = readFileSync("src/webview/terminal-studio-shell/App.tsx", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toContain("Git worktree isolation");
    for (const key of TERMINAL_STRIPPED_AGENT_KEYS) {
      expect(src, `App.tsx writes '${key}', which the loader refuses for a terminal`).not.toContain(`set("${key}"`);
      expect(src, `App.tsx reads fields.${key}, which the loader refuses for a terminal`).not.toContain(`fields.${key}`);
    }
  });
});
