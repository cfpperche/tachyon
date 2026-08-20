import type { OnboardingModel } from "@tachyon/webview-ui/webview/onboarding/messages";
import type { Fixture } from "../routes";

/**
 * t-505f13 — the three shapes the onboarding screen has:
 *  - `fresh` — a folder with no tachyon.yml and a healthy machine: steps 1 done, 2 current.
 *  - `missing-cli` — the card's DONE_WHEN 2 scenario: no attested agent CLI on PATH, so the
 *    checklist NAMES the runtimes to install and the Initialize button is disabled — the state
 *    today's user crosses with no warning on screen at all.
 *  - `all-set` — configured, attached, agents exist: the "You're set up" collapse the experienced
 *    user should land on instead of a tour.
 */

const healthyEnvironment = {
  items: [
    { id: "tmux", label: "tmux", status: "ok", detail: "tmux 3.4" },
    { id: "node", label: "Node.js", status: "ok", detail: "engine runtime at /usr/bin/node" },
    { id: "agent-cli", label: "Agent runtime", status: "ok", detail: "on PATH: claude, codex, grok" },
    { id: "credential", label: "Credentials", status: "ok", detail: "2 stored, none missing" },
  ],
  ready: true,
  checkedAt: "2026-08-20T17:40:00.000Z",
};

export const onboardingFixtures: Record<string, Fixture<OnboardingModel>> = {
  fresh: {
    provenance: "synthetic-edge",
    vm: {
      folders: [{ name: "my-project", root: "/home/user/code/my-project", configured: false, attached: false }],
      environment: healthyEnvironment,
    },
  },
  "missing-cli": {
    provenance: "synthetic-edge",
    vm: {
      folders: [{ name: "my-project", root: "/home/user/code/my-project", configured: false, attached: false }],
      environment: {
        items: [
          { id: "tmux", label: "tmux", status: "ok", detail: "tmux 3.4" },
          { id: "node", label: "Node.js", status: "ok", detail: "engine runtime at /usr/bin/node" },
          {
            id: "agent-cli", label: "Agent runtime", status: "missing", detail: "no attested agent CLI on PATH",
            remedy: "Install one of claude, codex, grok, pi and sign in — Tachyon runs agents through these CLIs, so without one no agent can start.",
          },
          { id: "credential", label: "Credentials", status: "info", detail: "checked when your first agent declares one" },
        ],
        ready: false,
        checkedAt: "2026-08-20T17:40:00.000Z",
      },
    },
  },
  "all-set": {
    provenance: "synthetic-edge",
    vm: {
      folders: [{ name: "my-project", root: "/home/user/code/my-project", configured: true, attached: true }],
      environment: healthyEnvironment,
      agentCount: 2,
    },
  },
  "first-agent": {
    provenance: "synthetic-edge",
    vm: {
      folders: [{ name: "my-project", root: "/home/user/code/my-project", configured: true, attached: true }],
      environment: healthyEnvironment,
      agentCount: 0,
    },
  },
};
