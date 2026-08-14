import { describe, it, expect } from "vitest";
import { parseSkillFrontmatter } from "../../apps/vscode-extension/src/plugins/skill.js";

const md = (fm: string, body = "\n# Skill body\n") => `---\n${fm}\n---${body}`;

describe("parseSkillFrontmatter", () => {
  it("parses a valid SKILL.md frontmatter (name + description) and trims the description", () => {
    const r = parseSkillFrontmatter(md("name: pdf-processing\ndescription:  Extract text from PDFs  "));
    expect(r.errors).toEqual([]);
    expect(r.frontmatter).toEqual({ name: "pdf-processing", description: "Extract text from PDFs" });
  });

  it("ignores extra frontmatter keys (only name + description are required in v1)", () => {
    const r = parseSkillFrontmatter(md("name: deploy\ndescription: Deploy the app\nlicense: MIT\nversion: 1"));
    expect(r.frontmatter).toEqual({ name: "deploy", description: "Deploy the app" });
  });

  it("rejects a file with no frontmatter block", () => {
    const r = parseSkillFrontmatter("# Just a heading\nno frontmatter here");
    expect(r.frontmatter).toBeUndefined();
    expect(r.errors[0]).toMatch(/missing YAML frontmatter/);
  });

  it("rejects invalid YAML in the frontmatter", () => {
    const r = parseSkillFrontmatter(md("name: x\n  : : bad"));
    expect(r.frontmatter).toBeUndefined();
    expect(r.errors[0]).toMatch(/invalid YAML|frontmatter/);
  });

  it("rejects a missing name", () => {
    const r = parseSkillFrontmatter(md("description: no name here"));
    expect(r.errors.some((e) => /'name'/.test(e))).toBe(true);
  });

  it("rejects a non-kebab name", () => {
    expect(parseSkillFrontmatter(md("name: Pdf_Processing\ndescription: d")).errors.some((e) => /'name'/.test(e))).toBe(true);
    expect(parseSkillFrontmatter(md("name: -leading\ndescription: d")).errors.some((e) => /'name'/.test(e))).toBe(true);
  });

  it("rejects a missing or empty description", () => {
    expect(parseSkillFrontmatter(md("name: ok")).errors.some((e) => /'description'/.test(e))).toBe(true);
    expect(parseSkillFrontmatter(md("name: ok\ndescription: '   '")).errors.some((e) => /'description'/.test(e))).toBe(true);
  });

  it("rejects an oversized file", () => {
    const r = parseSkillFrontmatter(md(`name: ok\ndescription: ${"x".repeat(70_000)}`));
    expect(r.frontmatter).toBeUndefined();
    expect(r.errors[0]).toMatch(/exceeds/);
  });

  it("rejects YAML anchors/aliases (bomb defense — maxAliasCount 0)", () => {
    const r = parseSkillFrontmatter("---\nname: ok\ndescription: &x hello\ndup: *x\n---\nbody");
    expect(r.frontmatter).toBeUndefined();
    expect(r.errors[0]).toMatch(/invalid YAML|frontmatter/);
  });

  it("accepts CRLF frontmatter delimiters", () => {
    const r = parseSkillFrontmatter("---\r\nname: win-skill\r\ndescription: works on CRLF\r\n---\r\nbody");
    expect(r.frontmatter).toEqual({ name: "win-skill", description: "works on CRLF" });
  });
});
