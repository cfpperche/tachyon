import type { NotifyLevel } from "../bridge/tools.js";
import type { NoticeAction } from "./EngineHost.js";
import { describeAuthRequired, runtimeLoginCommand, type AuthRequiredEvidence } from "@tachyon/shared/runtime/authRequired.js";

/**
 * t-2656d7 (SDD 495, first slice) — how a launch refused for credentials is presented.
 *
 * **This function exists to hold one invariant: the notice it returns always carries at least one
 * action.** That is not a style preference, it is the whole defect. A notice with an empty actions
 * array takes the `vscode.window.setStatusBarMessage(…, 8_000)` branch in
 * `src/workspace/notify.ts:41` — clipped to the width of one status-bar cell and erased after eight
 * seconds, with no history, no hover and nothing to press. On 2026-08-07 the owner started a Grok
 * agent and read `isolated harness for 'grok': no credentials at /home/gc` there. The rest of that
 * sentence — `— run grok login first` — was past the clip, so he concluded Grok was unsupported and
 * asked when the product would enable it. Tachyon knew the answer and printed it where sentences
 * cannot be read.
 *
 * A non-empty array is the entire difference. The mid-run path has always proved it:
 * `Workspace.ts` reports the same condition with `[{ label: "Open", … }]`, and that lands as a
 * persistent, actionable row instead of a flash. So the launch boundary produces the same value,
 * through the same channel, in the same words (`describeAuthRequired`) — one condition, one
 * vocabulary.
 *
 * The reason this is a separate, pure function rather than three lines inside `Workspace` is that
 * the invariant has to be testable for EVERY runtime, including the ones whose end-to-end launch is
 * awkward to drive. `test/unit/authRequiredLaunchNotice.test.ts` asserts it across all of them, so a
 * future edit that drops the actions fails there instead of silently going back to the status bar.
 */
export interface AuthRequiredNoticeHandlers {
  /**
   * Start the agent again. ALWAYS present, and always a human gesture.
   *
   * SDD 495 Q3, decided by the owner against his own live case (which wanted the automatic start):
   * Tachyon does not start the agent when a login succeeds. It offers this control and waits. The
   * standing rule that Tachyon never restarts anything unasked won, and `describeAuthRequired`
   * already promises exactly that in its last sentence — this action is what makes the promise
   * survivable for the human instead of leaving them to find the ▶ again.
   */
  retry: () => void | Promise<void>;
  /**
   * Run that runtime's own login in a governed editor-tab terminal (SDD 495 Q2). Absent for a
   * runtime with no measured login command, which is a declaration and not an oversight — see
   * `RUNTIME_LOGIN`. Such a refusal still reaches the human readably; it just carries no button.
   */
  login?: () => void | Promise<void>;
}

export interface AuthRequiredNotice {
  message: string;
  level: NotifyLevel;
  /** Never empty. See the contract above. */
  actions: NoticeAction[];
}

export function authRequiredLaunchNotice(
  agent: string,
  evidence: AuthRequiredEvidence,
  handlers: AuthRequiredNoticeHandlers,
  t: (message: string, ...args: (string | number | boolean)[]) => string = (message) => message,
): AuthRequiredNotice {
  const actions: NoticeAction[] = [];
  // The verb goes in the LABEL, deliberately. Whatever surface renders this, its title is
  // width-bounded somewhere — that is what the incident was made of — and a clipped sentence beside
  // a button reading "Log in" still transmits the fix, while a clipped sentence alone does not.
  if (handlers.login && runtimeLoginCommand(evidence.runtime)) {
    actions.push({ label: t("Log in"), run: handlers.login });
  }
  actions.push({ label: t("Retry"), run: handlers.retry });
  return {
    // Same sentence the mid-run path uses. It names runtime, agent and the safe action, and it
    // carries no credential material — that bound is `describeAuthRequired`'s, inherited unchanged.
    message: describeAuthRequired(agent, evidence),
    // `warn`, matching the mid-run auth notice: this is a human's to-do, not a Tachyon fault.
    level: "warn",
    actions,
  };
}

/**
 * t-2656d7 — the follow-up when a login pane exits.
 *
 * The pane exiting is not proof the login worked, and this slice deliberately does not probe (SDD
 * 495 Q1: no pre-launch probe). So the notice says what actually happened — the pane finished — and
 * hands back the same explicit `Retry` the human was promised. Tachyon starts nothing.
 */
export function loginFinishedNotice(
  runtime: string,
  agents: readonly string[],
  handlers: { retry: (agent: string) => void | Promise<void>; openPane: () => void | Promise<void> },
  t: (message: string, ...args: (string | number | boolean)[]) => string = (message) => message,
): AuthRequiredNotice {
  const actions: NoticeAction[] = agents.map((agent) => ({
    label: t("Retry {0}", agent),
    run: () => handlers.retry(agent),
  }));
  // Always at least one action, for the same reason as above: with none, this lands in the status
  // bar and the human never learns the login pane is done.
  actions.push({ label: t("Open login pane"), run: handlers.openPane });
  return {
    message: agents.length > 0
      ? t(
        "the {0} login pane has exited — start {1} again when the login succeeded. Tachyon will not start it for you.",
        runtime,
        agents.join(", "),
      )
      : t("the {0} login pane has exited.", runtime),
    level: "warn",
    actions,
  };
}
