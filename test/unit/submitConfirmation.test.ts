import { describe, expect, it } from "vitest";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import { classifyComposerSubmission, composerText } from "../../src/runtime/composerRegion.js";
import { runtimeProfile } from "../../src/runtime/runtimeProfile.js";

/**
 * t-8d190f — notify_agent typed a line into claude-opus5's composer and reported success, but no Enter
 * transition ever happened: the pane sat idle showing `yes, switch to t-2600f8` at the prompt until a
 * raw `tmux send-keys ... Enter` unstuck it.
 *
 * The old guard (`looksLikeStrandedSubmittedLine`) inspected the LAST meaningful line of the pane and
 * required it to be `<glyph> <text>`. A real Claude pane never looks like that — the composer has
 * status furniture under it — so the guard returned "not stranded", which the caller read as
 * "submitted". Every existing test used a bare `> text` pane, a shape the product never renders.
 *
 * Every escaped string below is the measured Claude Code 2.1.220 rendering recorded by t-6ffa13 in
 * claudeComposerHistoryEcho.test.ts. The discriminator is never what a message SAYS.
 */

const CLAUDE = runtimeProfile("claude")!.composer!;
const NOTICE = "yes, switch to t-2600f8"; // the incident's own line

/** Live editor: U+00A0 after the glyph, no background. Measured. */
const composerLine = (text: string) => `\x1b[39m❯ ${text}`;
/** Empty editor in the 256-colour theme a harness-spawned agent runs. Measured. */
const EMPTY_COMPOSER = "\x1b[38;5;246m❯ \x1b[39m";
/** A message the runtime ALREADY accepted, echoed into the transcript: background-painted glyph. */
const echoLine = (text: string) => `\x1b[38;5;239m\x1b[48;5;237m❯ \x1b[38;5;231m${text}\x1b[39m`;

/**
 * The real tail. The composer is NOT the last line — a rule and the auto-mode footer sit under it,
 * which is exactly what blinded the old last-line guard.
 */
function claudePane(composer: string, opts: { echo?: string } = {}): string {
  return [
    "\x1b[38;5;114m●\x1b[39m Done. Created notes.md",
    "",
    ...(opts.echo ? [echoLine(opts.echo), ""] : []),
    "\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mCooked for 14s\x1b[39m",
    "\x1b[38;5;37m────────────────────────────────────\x1b[39m",
    composer,
    "\x1b[38;5;37m────────────────────────────────────\x1b[39m",
    "\x1b[39m  \x1b[38;5;220m⏵⏵ auto mode on\x1b[39m",
  ].join("\n");
}

/**
 * A tmux stand-in whose pane reacts to Enter. `lostEnters` swallows that many C-m presses before the
 * composer clears — the mechanical shape of the incident, with no reference to the text's content.
 */
function claudeSession(opts: { lostEnters?: number; staged?: string; onClear?: string } = {}) {
  const staged = opts.staged ?? NOTICE;
  let remainingLosses = opts.lostEnters ?? 0;
  let cleared = false;
  const calls: string[][] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args.at(-1) === "C-m") {
      if (remainingLosses > 0) remainingLosses -= 1;
      else cleared = true;
      return { stdout: "", stderr: "" };
    }
    if (args.includes("capture-pane")) {
      // Once accepted, the runtime echoes the submitted line into the transcript (t-6ffa13) and the
      // editor goes back to empty.
      return {
        stdout: cleared ? claudePane(opts.onClear ?? EMPTY_COMPOSER, { echo: staged }) : claudePane(composerLine(staged)),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  const enters = () => calls.filter((c) => c.at(-1) === "C-m").length;
  const typed = () => calls.filter((c) => c.includes("-l") || c.includes("paste-buffer"));
  return { calls, exec, enters, typed };
}

describe("t-8d190f — a submit is confirmed by the composer, not assumed", () => {
  it("THE MEASURED BUG: a line left staged in a real Claude composer is NOT reported as delivered", async () => {
    // Every Enter is swallowed, so the text never leaves the editor. Before this fix the call
    // returned void after one Enter and the caller announced success.
    const s = claudeSession({ lostEnters: 99 });
    const receipt = await new TmuxService(s.exec).sendSubmittedLine("s1", NOTICE, {
      delayMs: 0,
      submitRetries: 3,
      composer: CLAUDE,
    });

    expect(receipt.status).toBe("submit-unconfirmed");
    expect(receipt.reason).toBe("still-staged");
  });

  it("the old last-line guard is blind to that same pane — why the bug escaped its tests", async () => {
    const { looksLikeStrandedSubmittedLine } = await import("../../src/tmux/TmuxService.js");
    const plain = claudePane(composerLine(NOTICE)).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

    // The text is demonstrably sitting in the editor...
    expect(composerText(plain, CLAUDE)).toBe(NOTICE);
    // ...yet the old guard says nothing is stranded, because it only ever looked at the last line.
    expect(looksLikeStrandedSubmittedLine(plain, NOTICE)).toBe(false);
    expect(plain.trimEnd().split("\n").at(-1)).toContain("auto mode on");
  });

  it("confirms delivery when the composer clears, and presses Enter exactly once", async () => {
    const s = claudeSession();
    const receipt = await new TmuxService(s.exec).sendSubmittedLine("s1", NOTICE, {
      delayMs: 0,
      composer: CLAUDE,
    });

    expect(receipt).toEqual({ status: "submitted", reason: "composer-cleared", attempts: 1 });
    expect(s.enters()).toBe(1);
  });

  it("a lost Enter is retried until the composer clears, and then reports delivered", async () => {
    const s = claudeSession({ lostEnters: 2 });
    const receipt = await new TmuxService(s.exec).sendSubmittedLine("s1", NOTICE, {
      delayMs: 0,
      submitRetries: 3,
      composer: CLAUDE,
    });

    expect(receipt.status).toBe("submitted");
    expect(receipt.attempts).toBe(3);
    expect(s.enters()).toBe(3);
  });

  it("retry is idempotent: the text is typed once no matter how many Enters it takes", async () => {
    const s = claudeSession({ lostEnters: 2 });
    await new TmuxService(s.exec).sendSubmittedLine("s1", NOTICE, { delayMs: 0, submitRetries: 3, composer: CLAUDE });

    // Exactly one literal send — retries are bare Enters, so nothing can duplicate the line or
    // concatenate a second copy onto whatever is staged.
    expect(s.typed()).toHaveLength(1);
    expect(s.typed()[0]).toContain(NOTICE);
    expect(s.enters()).toBeGreaterThan(1);
  });

  it("t-e169e4: recovery submits an exact already-staged line without typing it again", async () => {
    const s = claudeSession({ lostEnters: 1 });
    const receipt = await new TmuxService(s.exec).sendStagedLine("s1", NOTICE, {
      delayMs: 0,
      submitRetries: 3,
      composer: CLAUDE,
    });

    expect(receipt).toEqual({ status: "submitted", reason: "composer-cleared", attempts: 2 });
    expect(s.typed()).toHaveLength(0);
    expect(s.enters()).toBe(2);
  });

  it("t-6ffa13: the runtime's echo of our own line is history, not a still-staged draft", async () => {
    // After acceptance the pane contains our exact text twice over — once as the transcript echo.
    // A pane-wide search would call that "still staged" and press Enter forever; scoping to the
    // composer region is what keeps this a single Enter.
    const s = claudeSession();
    const receipt = await new TmuxService(s.exec).sendSubmittedLine("s1", NOTICE, {
      delayMs: 0,
      submitRetries: 3,
      composer: CLAUDE,
    });

    expect(receipt.status).toBe("submitted");
    expect(s.enters()).toBe(1);
    // The echo really is present in the capture that produced that verdict.
    expect(claudePane(EMPTY_COMPOSER, { echo: NOTICE })).toContain(NOTICE);
  });

  it("stops instead of hammering Enter when someone else's text joins ours — draft protection", async () => {
    // The human typed while we were submitting. Another Enter would submit THEIR words.
    const pane = claudePane(composerLine(`${NOTICE} and also drop the branch`));
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<ExecResult> => {
      calls.push(args);
      return args.includes("capture-pane") ? { stdout: pane, stderr: "" } : { stdout: "", stderr: "" };
    };

    const receipt = await new TmuxService(exec).sendSubmittedLine("s1", NOTICE, {
      delayMs: 0,
      submitRetries: 3,
      composer: CLAUDE,
    });

    expect(receipt).toEqual({ status: "submit-unconfirmed", reason: "composer-diverged", attempts: 1 });
    expect(calls.filter((c) => c.at(-1) === "C-m")).toHaveLength(1);
  });

  it("an unreadable pane is reported, never laundered into success", async () => {
    const exec = async (args: string[]): Promise<ExecResult> => {
      if (args.includes("capture-pane")) throw new Error("pane is gone");
      return { stdout: "", stderr: "" };
    };

    const receipt = await new TmuxService(exec).sendSubmittedLine("s1", NOTICE, { delayMs: 0, composer: CLAUDE });

    expect(receipt.status).toBe("submit-unconfirmed");
    expect(receipt.reason).toBe("capture-failed");
  });

  it("classifies the four composer outcomes structurally, not by what the message says", () => {
    const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const other = "something entirely different";

    expect(classifyComposerSubmission(plain(claudePane(composerLine(NOTICE))), CLAUDE, NOTICE)).toBe("holds-text");
    expect(classifyComposerSubmission(plain(claudePane(EMPTY_COMPOSER)), CLAUDE, NOTICE)).toBe("cleared");
    expect(classifyComposerSubmission(plain(claudePane(composerLine(`${NOTICE} extra`))), CLAUDE, NOTICE)).toBe("diverged");
    // Someone else's draft: our line is gone, so delivery is confirmed and we must not press Enter again.
    expect(classifyComposerSubmission(plain(claudePane(composerLine(other))), CLAUDE, NOTICE)).toBe("cleared");
    // No composer anywhere in the capture proves nothing either way.
    expect(classifyComposerSubmission("just some output\nno editor here", CLAUDE, NOTICE)).toBe("unreadable");
  });

  it("excludes the runtime's status furniture from the composer content", () => {
    // The prompt-glyph region runs to the bottom of the pane, so the footer is inside it. Counting
    // that footer as staged text would make every submit look permanently unconfirmed.
    const plain = claudePane(EMPTY_COMPOSER).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(plain).toContain("auto mode on");
    expect(composerText(plain, CLAUDE)).toBe("");
  });

  it("an undeclared runtime keeps the legacy check and never claims a confirmation it lacks", async () => {
    // No composer profile: the weak last-line heuristic still runs, but its verdict is labelled for
    // what it is rather than being reported as an observed delivery.
    const { calls, exec } = (() => {
      const calls: string[][] = [];
      return {
        calls,
        exec: async (args: string[]): Promise<ExecResult> => {
          calls.push(args);
          return args.includes("capture-pane") ? { stdout: "some output\n", stderr: "" } : { stdout: "", stderr: "" };
        },
      };
    })();

    const receipt = await new TmuxService(exec).sendSubmittedLine("s1", NOTICE, { delayMs: 0 });

    expect(receipt.status).toBe("submitted");
    expect(receipt.reason).toBe("no-stranded-line");
    // Unprofiled captures stay plain — colours are only requested when a profile can use them.
    expect(calls.find((c) => c.includes("capture-pane"))).not.toContain("-e");
  });
});
