import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_AUTH_PREFLIGHT,
  RUNTIME_AUTH_PROFILES,
  RUNTIME_LOGIN,
  authRequiredFromHarness,
  authRequiredOf,
  runtimeLoginCommand,
} from "@tachyon/shared/runtime/authRequired.js";
import { authRequiredLaunchNotice, loginFinishedNotice } from "@tachyon/engine/workspace/authRequiredNotice.js";
import { initializeVsCodeNotifications } from "../../apps/vscode-extension/src/workspace/notify.js";
import { showNotificationActions } from "../../apps/vscode-extension/src/workspace/NotificationService.js";
import {
  __getQuickPickCalls,
  __getStatusBarMessages,
  __resetVscodeMock,
  __setQuickPickResult,
} from "../mocks/vscode.js";

/**
 * t-2656d7 (SDD 495, first slice) — the branch that ate the owner's recovery instruction.
 *
 * On 2026-08-07 he started a Grok agent and read `isolated harness for 'grok': no credentials at
 * /home/gc` in the status bar — clipped. The sentence ended in `— run grok login first`, he never saw
 * it, concluded Grok was unsupported, and asked when the product would enable it.
 *
 * The mechanism was one branch: with an EMPTY actions array the notification provider skips the
 * dialog entirely and calls `setStatusBarMessage(…, 8_000)`, which clips to one status-bar cell and
 * erases itself. A non-empty array is the whole difference.
 *
 * So this file asserts two things and treats them as one guard:
 *
 *  1. the coupling is real — empty actions DO land in the status bar and non-empty actions do NOT
 *     (measured here against the real provider, not asserted from a comment); and
 *  2. this branch always produces a non-empty array, for every runtime that can be refused,
 *     including the ones with no measured login command.
 *
 * Property (2) is the one that must not silently regress. `RUNTIME_LOGIN` is a partial record and
 * `handlers.login` is optional, so the tempting future edit — "only add actions when there is a
 * login command" — would put every other runtime straight back in the status bar. The `Retry` action
 * is what makes the array unconditionally non-empty, and it is also the explicit human retry the
 * owner's Q3 decision requires.
 */

/** Every runtime that can reach a credential refusal at the launch boundary. */
const REFUSABLE = [...new Set([
  ...Object.keys(RUNTIME_AUTH_PROFILES),
  ...Object.keys(RUNTIME_AUTH_PREFLIGHT),
])].sort();

const HARNESS_REFUSAL = "no credentials at /home/goat/.grok/auth.json — run grok login first (a redirected GROK_HOME starts logged out)";

/** What both real hosts do with `{0}` placeholders (`VsCodeHost.t` / `DaemonEngineHost.t`). */
const SUBSTITUTING_T = (message: string, ...args: (string | number | boolean)[]): string =>
  message.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)] ?? ""));

function noticeFor(runtime: string, agent = "grok-builder") {
  const evidence = authRequiredFromHarness(runtime, HARNESS_REFUSAL);
  expect(evidence, `${runtime} must produce launch evidence`).toBeDefined();
  return authRequiredLaunchNotice(agent, evidence!, {
    retry: () => {},
    ...(runtimeLoginCommand(evidence!.runtime) ? { login: () => {} } : {}),
  });
}

describe("t-2656d7 — the status-bar branch is exactly the empty-actions branch", () => {
  afterEach(() => __resetVscodeMock());

  it("an action-less notice IS the status bar, and nothing else", async () => {
    __resetVscodeMock();
    initializeVsCodeNotifications();

    await showNotificationActions("agent 'grok-builder' cannot run — run grok login first", "warn", []);

    // This is the owner's 2026-08-07 experience, reproduced: no dialog, one status-bar line on a timer.
    expect(__getStatusBarMessages()).toHaveLength(1);
    expect(__getQuickPickCalls()).toHaveLength(0);
  });

  it("one action is enough to leave it — the notice becomes a persistent pick instead", async () => {
    __resetVscodeMock();
    initializeVsCodeNotifications();
    __setQuickPickResult("Log in");

    let ran = false;
    await showNotificationActions("agent 'grok-builder' cannot run — run grok login first", "warn", [
      { label: "Log in", run: () => { ran = true; } },
    ]);

    expect(__getStatusBarMessages()).toHaveLength(0);
    expect(__getQuickPickCalls()).toHaveLength(1);
    // It survives a focus change rather than vanishing on a timer — the property the status bar lacks.
    expect((__getQuickPickCalls()[0]?.options as { ignoreFocusOut?: boolean })?.ignoreFocusOut).toBe(true);
    expect(ran).toBe(true);
  });
});

describe("t-2656d7 — the launch refusal always carries actions", () => {
  it.each(REFUSABLE)("%s: the notice is never action-less", (runtime) => {
    const notice = noticeFor(runtime);
    // The guard. Empty here means the status bar, and the status bar means the owner's incident.
    expect(notice.actions.length).toBeGreaterThan(0);
    expect(notice.actions.every((action) => action.label.length > 0)).toBe(true);
  });

  it.each(REFUSABLE)("%s: an explicit Retry is always offered, and Tachyon never presses it", (runtime) => {
    let retried = 0;
    const evidence = authRequiredFromHarness(runtime, HARNESS_REFUSAL)!;
    const notice = authRequiredLaunchNotice("worker", evidence, { retry: () => { retried += 1; } });

    const retry = notice.actions.find((action) => action.label === "Retry");
    expect(retry, "SDD 495 Q3 — the human's explicit retry control").toBeDefined();
    // Building the notice must not start anything. The owner decided this against his own live case.
    expect(retried).toBe(0);
    void retry?.run();
    expect(retried).toBe(1);
  });

  it("a runtime WITHOUT a measured login command still escapes the status bar", () => {
    // pi authenticates with `/login` inside Pi — there is no standalone command to put in a pane, so
    // `RUNTIME_LOGIN` declares nothing for it. That absence must cost the button, never the notice.
    expect(RUNTIME_LOGIN.pi).toBeUndefined();
    const notice = noticeFor("pi");
    expect(notice.actions.map((a) => a.label)).toEqual(["Retry"]);
  });

  it("a Log in button appears exactly for the runtimes with a measured login command", () => {
    for (const runtime of REFUSABLE) {
      const labels = noticeFor(runtime).actions.map((a) => a.label);
      expect(labels.includes("Log in"), `${runtime}`).toBe(RUNTIME_LOGIN[runtime as keyof typeof RUNTIME_LOGIN] !== undefined);
    }
  });

  it("refuses to invent a login button when the caller offers a handler for an undeclared runtime", () => {
    // Belt and braces: the wiring in Workspace already gates on `runtimeLoginCommand`, but a second
    // caller must not be able to promise a login Tachyon cannot run.
    const evidence = authRequiredFromHarness("pi", HARNESS_REFUSAL)!;
    const notice = authRequiredLaunchNotice("worker", evidence, { retry: () => {}, login: () => {} });
    expect(notice.actions.map((a) => a.label)).toEqual(["Retry"]);
  });

  it("the sentence is the mid-run vocabulary, not a second one", () => {
    const notice = noticeFor("grok", "grok-builder");
    // Same `describeAuthRequired` contract the running-agent hold uses: runtime, agent, safe action,
    // and the promise that nothing restarts on its own.
    expect(notice.message).toContain("agent 'grok-builder' cannot run");
    expect(notice.message).toContain("the grok runtime reports it is not authenticated");
    expect(notice.message).toContain("Tachyon will not retry or restart it automatically");
    expect(notice.level).toBe("warn");
  });

  it("carries no credential material — only a path, a runtime and an instruction", () => {
    const notice = noticeFor("grok");
    expect(notice.message).not.toMatch(/auth\.json|token|bearer|sk-|xai-/i);
  });
});

describe("t-2656d7 — evidence at the launch boundary", () => {
  it("reads the measured human action rather than composing a second one", () => {
    const evidence = authRequiredFromHarness("grok", HARNESS_REFUSAL);
    expect(evidence?.humanAction).toBe(RUNTIME_AUTH_PROFILES.grok?.humanAction);
  });

  it("covers the preflight-only runtime through its own declaration", () => {
    // opencode has no turn matcher (it degrades silently instead of erroring), so its wording lives
    // in RUNTIME_AUTH_PREFLIGHT. The harness refusal must still find it.
    expect(RUNTIME_AUTH_PROFILES.opencode).toBeUndefined();
    expect(authRequiredFromHarness("opencode", HARNESS_REFUSAL)?.humanAction)
      .toBe(RUNTIME_AUTH_PREFLIGHT.opencode?.humanAction);
  });

  it("an undeclared runtime yields nothing — the same refusal every other constructor makes", () => {
    expect(authRequiredFromHarness("some-new-cli", HARNESS_REFUSAL)).toBeUndefined();
    expect(authRequiredFromHarness(undefined, HARNESS_REFUSAL)).toBeUndefined();
  });

  it("bounds the echoed line", () => {
    const evidence = authRequiredFromHarness("grok", `${"x".repeat(5_000)} — run grok login first`);
    expect(evidence!.matchedLine.length).toBeLessThanOrEqual(301);
  });

  it("authRequiredOf reads the field off an error, and ignores anything else", () => {
    const evidence = authRequiredFromHarness("grok", HARNESS_REFUSAL)!;
    expect(authRequiredOf(Object.assign(new Error("x"), { authRequired: evidence }))).toBe(evidence);
    expect(authRequiredOf(new Error("plain"))).toBeUndefined();
    expect(authRequiredOf(undefined)).toBeUndefined();
    expect(authRequiredOf({ authRequired: { runtime: 7 } })).toBeUndefined();
  });
});

describe("t-2656d7 — every declared login command states what it was measured on", () => {
  it.each(Object.entries(RUNTIME_LOGIN))("%s", (_runtime, profile) => {
    expect(profile!.source).toBe("measured");
    expect(profile!.verified).toBe(true);
    expect(profile!.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile!.notes.length).toBeGreaterThan(20);
    // The command must be runnable in a pane — a slash command typed inside a running TUI is not.
    expect(profile!.command.startsWith("/")).toBe(false);
  });

  it("only declares runtimes whose auth wording was also measured", () => {
    for (const runtime of Object.keys(RUNTIME_LOGIN)) {
      expect(authRequiredFromHarness(runtime, HARNESS_REFUSAL), runtime).toBeDefined();
    }
  });
});

describe("t-2656d7 — the login pane finishing offers a retry and starts nothing", () => {
  it("names every agent that was waiting, and presses none of them", () => {
    const started: string[] = [];
    const notice = loginFinishedNotice("grok", ["alpha", "beta"], {
      retry: (agent) => { started.push(agent); },
      openPane: () => {},
    }, SUBSTITUTING_T);

    expect(started).toEqual([]);
    expect(notice.actions.length).toBeGreaterThan(0);
    expect(notice.actions.map((a) => a.label)).toEqual(["Retry alpha", "Retry beta", "Open login pane"]);
    void notice.actions[0]?.run();
    expect(started).toEqual(["alpha"]);
  });

  it("still carries an action when nobody was waiting", () => {
    const notice = loginFinishedNotice("codex", [], { retry: () => {}, openPane: () => {} });
    expect(notice.actions.length).toBeGreaterThan(0);
  });
});
