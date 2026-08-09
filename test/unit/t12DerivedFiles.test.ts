import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { briefFilePath, deliverableBody, BRIEF_FILE_THRESHOLD } from "../../src/agents/briefFile.js";
import { forgetAgent } from "../../src/agents/forgetAgent.js";
import { makeTempDir } from "../helpers/tempDir.js";

describe("T12 private derived agent files", () => {
  it("keeps one private copy per agent and removes only generated copies on permanent forget", () => {
    const workspaceRoot = makeTempDir("tachyon-t12-");
    const agent = "private-agent";
    const firstBody = `distinctive-first-${"a".repeat(BRIEF_FILE_THRESHOLD)}`;
    const finalBody = `distinctive-final-${"b".repeat(BRIEF_FILE_THRESHOLD)}`;
    const brief = briefFilePath(workspaceRoot, agent);
    const anchor = path.join(workspaceRoot, ".tachyon", "anchors", `${agent}.md`);
    const canonical = path.join(workspaceRoot, ".tachyon", "agents", agent, "notes.md");

    expect(fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8")).toMatch(/^\.tachyon\/$/m);

    deliverableBody(workspaceRoot, agent, firstBody);
    deliverableBody(workspaceRoot, agent, finalBody);
    fs.mkdirSync(path.dirname(anchor), { recursive: true, mode: 0o700 });
    fs.writeFileSync(anchor, finalBody, { mode: 0o600 });
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, finalBody);

    expect(fs.readFileSync(brief, "utf8")).toBe(finalBody);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(brief)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(brief).mode & 0o777).toBe(0o600);
    }

    forgetAgent(agent, { workspaceRoot });

    expect(fs.existsSync(brief)).toBe(false);
    expect(fs.existsSync(anchor)).toBe(false);
    expect(fs.readFileSync(canonical, "utf8")).toBe(finalBody);
    const remaining = fs.readdirSync(path.join(workspaceRoot, ".tachyon"), { recursive: true })
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => path.join(workspaceRoot, ".tachyon", entry))
      .filter((entry) => fs.statSync(entry).isFile())
      .map((entry) => fs.readFileSync(entry, "utf8"));
    expect(remaining).not.toContain(firstBody);
  });
});
