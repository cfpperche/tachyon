import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSoul } from "../../src/agents/soul.js";
import { openingPromptCapability } from "../../src/agents/openingPromptCapability.js";
import { parseConfig } from "../../src/config/loadConfig.js";

describe("container-generated delegation behavior", () => {
  it("agent soul profile foundation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachyon-soul-foundation-"));
    const dir = path.join(root, ".tachyon", "agents", "reviewer");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SOUL.md"), "Calm, exact, and candid.\r\n");
    await writeFile(path.join(dir, "profile.json"), JSON.stringify({ schemaVersion: 1, profileId: "123e4567-e89b-42d3-a456-426614174000", owner: "reviewer", state: "active" }), { mode: 0o600 });
    const parsed = parseConfig("agents:\n  reviewer:\n    cmd: codex\n    soul: true\n");
    expect(parsed.errors).toEqual([]);
    expect(parsed.config?.agents.reviewer.soul).toBe(true);
    const soul = await resolveSoul(root, "reviewer");
    expect(soul.body).toBe("Calm, exact, and candid.\r\n");
    expect(soul.profileId).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(openingPromptCapability("env FOO=1 opencode")).toEqual({ status: "prompt", runtime: "opencode", channel: "tui-prefill" });
    expect(openingPromptCapability("hermes").status).toBe("native-external");
  });
});
