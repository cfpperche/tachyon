import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePromptMarkdown, PromptStore } from "@tachyon/engine/prompts/PromptStore.js";

describe("parsePromptMarkdown", () => {
  it("parses frontmatter title and body", () => {
    const r = parsePromptMarkdown(
      "---\ntitle: Review auth\nextra: ignored\n---\n\nReview only auth.\nFlag risk.\n",
      "review-auth",
    );
    expect(r).toEqual({ ok: true, title: "Review auth", body: "Review only auth.\nFlag risk." });
  });

  it("uses id as title when no frontmatter", () => {
    const r = parsePromptMarkdown("plain body line\n", "status-next");
    expect(r).toEqual({ ok: true, title: "status-next", body: "plain body line" });
  });

  it("rejects empty body", () => {
    expect(parsePromptMarkdown("   \n", "x").ok).toBe(false);
    expect(parsePromptMarkdown("---\ntitle: t\n---\n\n  \n", "x").ok).toBe(false);
  });

  it("rejects non-mapping frontmatter", () => {
    const r = parsePromptMarkdown("---\n- just\n- a list\n---\nbody\n", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mapping/);
  });
});

describe("PromptStore.list", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-prompts-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when .tachyon/prompts is missing", () => {
    const lib = new PromptStore(root).list();
    expect(lib.templates).toEqual([]);
    expect(lib.skipped).toEqual([]);
  });

  it("loads valid markdown files and skips bad names / empty bodies", () => {
    const dir = path.join(root, ".tachyon", "prompts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "review-auth.md"), "---\ntitle: Review auth\n---\nDo the review.\n");
    fs.writeFileSync(path.join(dir, "plain.md"), "hello world\n");
    fs.writeFileSync(path.join(dir, "1bad.md"), "nope\n");
    fs.writeFileSync(path.join(dir, "empty.md"), "---\ntitle: Empty\n---\n\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored\n");

    const lib = new PromptStore(root).list();
    expect(lib.templates.map((t) => t.id).sort()).toEqual(["plain", "review-auth"]);
    expect(lib.templates.find((t) => t.id === "review-auth")?.title).toBe("Review auth");
    expect(lib.templates.find((t) => t.id === "plain")?.body).toBe("hello world");
    expect(lib.skipped.some((s) => s.file === "1bad.md")).toBe(true);
    expect(lib.skipped.some((s) => s.file === "empty.md")).toBe(true);
  });
});
