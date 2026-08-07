import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importSoulProfile, resolveSoul, SoulError } from "../../src/agents/soul.js";
import { openingPromptCapability } from "../../src/agents/openingPromptCapability.js";
import { asAgent, composeCommand, instructionsDeliverable, parseConfig } from "../../src/config/loadConfig.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("container-generated delegation behavior", () => {
  it("agent soul profile foundation closure", async () => {
    const parsed = parseConfig("agents:\n  Ada:\n    cmd: env FOO=1 opencode\n    soul: true\n  ada:\n    cmd: codex\n    soul: true\n");
    // t-48dd8d — the file loads now, and the COLLIDING declaration is the one discarded: two agents
    // folding to one name would otherwise share the profile SOUL.md is keyed by. File order decides,
    // so 'Ada' keeps its soul and the later 'ada' loses the key the message already named.
    expect(parsed.errors).toEqual([]);
    expect(asAgent(parsed.config?.agents.Ada)?.soul).toBe(true);
    expect(asAgent(parsed.config?.agents.ada)?.soul).toBeUndefined();
    expect(parsed.warnings.some((warning) =>
      warning.startsWith("agents.ada.soul: conflicts with soul-enabled agent 'Ada' after ASCII case folding"))).toBe(true);

    expect(openingPromptCapability("env -u TOKEN opencode")).toEqual({ status: "prompt", runtime: "opencode", channel: "tui-prefill" });
    expect(openingPromptCapability("bash -lc codex").status).toBe("unsupported");
    expect(openingPromptCapability("hermes").status).toBe("native-external");
    expect(instructionsDeliverable("env -u TOKEN codex")).toBe(true);
    expect(composeCommand({ cmd: "env -u TOKEN codex", instructions: "exact" })).toBe("env -u TOKEN codex 'exact'");

    const root = makeTempDir("tachyon-soul-closure-");
    const imports = makeTempDir("tachyon-soul-source-");
    const source = path.join(imports, "SOUL.md");
    await writeFile(source, "exact\r\nbytes\n");
    const imported = await importSoulProfile(root, "Ada", source);
    await writeFile(source, "mutated");
    const resolved = await resolveSoul(root, "Ada");
    expect(resolved.body).toBe("exact\r\nbytes\n");
    expect(resolved.sha256).toBe(imported.sha256);
    expect(JSON.stringify(imported)).not.toContain(imports);

    await expect(importSoulProfile(root, "Ada", source)).rejects.toMatchObject({ code: "soul/profile-adoption-required", retryable: false } satisfies Partial<SoulError>);
    const manifest = JSON.parse(await readFile(path.join(root, ".tachyon", "agents", "Ada", "profile.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["owner", "profileId", "schemaVersion", "state"]);

    const badRoot = makeTempDir("tachyon-soul-bad-manifest-");
    const profile = path.join(badRoot, ".tachyon", "agents", "Ada");
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "SOUL.md"), "identity");
    await writeFile(path.join(profile, "profile.json"), JSON.stringify({ ...manifest, extra: true }), { mode: 0o600 });
    await expect(resolveSoul(badRoot, "Ada")).rejects.toMatchObject({ code: "soul/profile-adoption-required", retryable: false });
  });
});
