import { describe, expect, it } from "vitest";
import {
  REDACTED,
  classifySetting,
  describeHook,
  foldWrappedStatusLine,
  inspectEnv,
  isSecretEnvKey,
  redactCommand,
  type InspectedSetting,
} from "../../src/runtimeOps/sessionInspection.js";

/**
 * t-283149 — the session inspector shows what Tachyon handed the runtime. Two of its decisions are the
 * ones worth holding down: what counts as a secret, and where a settings key came from.
 */
describe("t-283149 — secrets never leave the inspector in the clear", () => {
  it("decides by key, matching what pane-output redaction already treats as secret", () => {
    // spec 351 uses "contains TOKEN". Value-shape heuristics are avoided on purpose: they miss a
    // secret that does not look like one, and that failure is silent.
    expect(isSecretEnvKey("TACHYON_BRIDGE_TOKEN")).toBe(true);
    expect(isSecretEnvKey("TACHYON_AGENT_BRIDGE_TOKEN")).toBe(true);
    expect(isSecretEnvKey("some_secret_value")).toBe(true);
    expect(isSecretEnvKey("TACHYON_AGENT_NAME")).toBe(false);
    expect(isSecretEnvKey("CLAUDE_CONFIG_DIR")).toBe(false);
  });

  it("redacts token values in env while keeping the key visible", () => {
    // The KEY must stay: "a bridge token is present" is the useful fact; its value never is.
    const env = inspectEnv({
      TACHYON_AGENT_NAME: "claude",
      TACHYON_BRIDGE_TOKEN: "fake-token-for-tests-000000000000",
      HOME: "/home/goat",
    }, ["CLAUDE_CONFIG_DIR"]);

    expect(env).toEqual([
      { key: "TACHYON_AGENT_NAME", value: "claude" },
      { key: "TACHYON_BRIDGE_TOKEN", value: REDACTED },
    ]);
  });

  it("includes runtime config-home keys the caller names, and nothing else", () => {
    const env = inspectEnv({ CLAUDE_CONFIG_DIR: "/private/home", PATH: "/usr/bin", GROK_HOME: "/g" }, ["CLAUDE_CONFIG_DIR"]);

    expect(env.map((entry) => entry.key)).toEqual(["CLAUDE_CONFIG_DIR"]);
  });

  it("scrubs a secret from the launch command in both argv shapes", () => {
    const secret = "fake-token-for-tests-000000000000";
    const argv = ["claude", "--token", secret, `--bridge=${secret}`, "--model", "opus"];

    expect(redactCommand(argv, [secret])).toEqual([
      "claude", "--token", REDACTED, `--bridge=${REDACTED}`, "--model", "opus",
    ]);
  });

  it("ignores short secrets so a common word never blanks the command", () => {
    // A one-or-two character "secret" would match everywhere and destroy the very thing this view is
    // for. Short values are left alone rather than turning the argv into dots.
    expect(redactCommand(["claude", "--model", "opus"], ["o"])).toEqual(["claude", "--model", "opus"]);
  });
});

describe("t-283149 — a settings key says where it came from, including when it never arrived", () => {
  const where = {
    projectable: ["permissions", "theme", "statusLine"],
    hostInjected: ["hooks", "skipDangerousModePermissionPrompt"],
    agentOwned: ["model"],
  };

  it("names host, agent-owned and projected keys", () => {
    expect(classifySetting("hooks", where, false)).toBe("host");
    expect(classifySetting("model", where, false)).toBe("agent-owned");
    expect(classifySetting("theme", where, true)).toBe("projected");
  });

  it("marks a global key outside the allowlist as NOT projected", () => {
    // The case the whole function exists for. A key sitting in the person's global config that the
    // family allowlist does not carry never reaches the agent — no error, no warning, it just does
    // not act. That is how t-084b28 survived three releases.
    expect(classifySetting("switchModelsOnFlag", where, true)).toBe("not-projected");
    expect(classifySetting("skipDangerousModePermissionPrompt", where, true)).toBe("host");
  });
});

describe("t-283149 — a wrapped status line is one row, not two", () => {
  const settings: InspectedSetting[] = [
    { key: "statusLine", value: "bash ~/.claude/statusline-command.sh", origin: "projected" },
    { key: "statusLine", value: "node capture-wrapper.cjs", origin: "host" },
    { key: "theme", value: "dark-ansi", origin: "projected" },
  ];

  it("folds the projected row into the host row it is wrapped by", () => {
    // The host wrapper carries the person's command as priorCommand and runs it inside itself, so the
    // person still sees their status line. Two competing rows would be a lie about what happens.
    const folded = foldWrappedStatusLine(settings, "bash ~/.claude/statusline-command.sh");

    expect(folded.filter((setting) => setting.key === "statusLine")).toEqual([
      { key: "statusLine", value: "node capture-wrapper.cjs", origin: "host", wraps: "bash ~/.claude/statusline-command.sh" },
    ]);
    expect(folded).toHaveLength(2);
  });

  it("leaves both rows alone when nothing was wrapped", () => {
    // No priorCommand means the host did NOT compose — claiming a wrap here would invent one.
    expect(foldWrappedStatusLine(settings, undefined)).toHaveLength(3);
  });
});

describe("t-283149 — hooks say what they are for, and only when we authored them", () => {
  it("names purpose and sink for each Tachyon hook", () => {
    const hook = describeHook("SessionStart", "node '/ws/.tachyon/activity/session-owner-record.cjs' 'claude'");

    expect(hook.purpose).toBe("records which agent owns this session");
    expect(hook.writes).toBe(".tachyon/activity/session-owners.jsonl");
  });

  it("leaves a hook we did not author undescribed rather than guessing", () => {
    // The person's own hooks are theirs. Inventing a purpose line would be the inspector asserting
    // something it does not know.
    const hook = describeHook("PreToolUse", "bash /home/goat/my-own-hook.sh");

    expect(hook.purpose).toBeUndefined();
    expect(hook.writes).toBeUndefined();
    expect(hook.command).toBe("bash /home/goat/my-own-hook.sh");
  });
});
