import { describe, expect, it } from "vitest";
import {
  CODEX_CATALOG_MAX_BYTES,
  CODEX_CATALOG_MAX_DEPTH,
  CODEX_CATALOG_MAX_SLUG_LENGTH,
  CODEX_CATALOG_MAX_SLUGS,
  CodexCatalogStreamParser,
  type CodexCatalogStreamResult,
} from "../../src/runtime/adapters/codexCatalogStream.js";

function parseBuffer(input: Buffer, chunkSize = input.length || 1): CodexCatalogStreamResult {
  const parser = new CodexCatalogStreamParser();
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const state = parser.write(input.subarray(offset, Math.min(offset + chunkSize, input.length)));
    if (state !== "continue") return { state };
  }
  return parser.finish();
}

function parseText(input: string, chunkSize?: number): CodexCatalogStreamResult {
  return parseBuffer(Buffer.from(input), chunkSize);
}

describe("CodexCatalogStreamParser", () => {
  it("projects only selectable slugs from metadata larger than the legacy raw buffer", () => {
    const input = Buffer.from(JSON.stringify({
      metadata: { description: `prefix\\"${"x".repeat(300 * 1024)}` },
      models: [
        { slug: "gpt-5.6-sol", visibility: "list", base_instructions: "must never be retained" },
        { slug: "gpt-hidden", visibility: "hide", base_instructions: "also private" },
        { slug: "gpt-5.6-terra", visibility: "list", nested: { slug: "not-a-model", visibility: "list" } },
      ],
    }));
    expect(input.length).toBeGreaterThan(256 * 1024);
    expect(parseBuffer(input, 257)).toEqual({ state: "ok", slugs: ["gpt-5.6-sol", "gpt-5.6-terra"] });
  });

  it("handles UTF-8, escapes, and tokens split at every byte boundary", () => {
    const input = JSON.stringify({
      note: "foguete 🚀 e aspas \\\"",
      models: [{ slug: "gpt-modelo-é", visibility: "list" }],
    });
    expect(parseText(input, 1)).toEqual({ state: "ok", slugs: ["gpt-modelo-é"] });
  });

  it.each([
    "",
    "{}",
    '{"models":{}}',
    '{"models":[,]}',
    '{"models":[{"slug":"x","visibility":"list",}]}',
    '{"models":[]} trailing',
    '{"models":[]}\u00a0',
    '{"models":[{"slug":"x","visibility":"list"}]',
  ])("rejects malformed or structurally invalid input: %j", (input) => {
    expect(parseText(input)).toEqual({ state: "malformed" });
  });

  it("rejects malformed UTF-8", () => {
    expect(parseBuffer(Buffer.concat([Buffer.from('{"models":[]}'), Buffer.from([0xff])]))).toEqual({ state: "malformed" });
  });

  it("bounds total bytes, nesting depth, selectable entries, and slug length independently", () => {
    const bytes = new CodexCatalogStreamParser();
    expect(bytes.write(Buffer.alloc(CODEX_CATALOG_MAX_BYTES + 1, 0x20))).toBe("oversized");

    let nested = "null";
    for (let index = 0; index < CODEX_CATALOG_MAX_DEPTH + 1; index++) nested = `[${nested}]`;
    expect(parseText(`{"models":[{"slug":"ok","visibility":"list","metadata":${nested}}]}`)).toEqual({ state: "oversized" });

    const entries = Array.from({ length: CODEX_CATALOG_MAX_SLUGS + 1 }, (_, index) => ({ slug: `model-${index}`, visibility: "list" }));
    expect(parseText(JSON.stringify({ models: entries }))).toEqual({ state: "oversized" });

    const longSlug = "x".repeat(CODEX_CATALOG_MAX_SLUG_LENGTH + 1);
    expect(parseText(JSON.stringify({ models: [
      { slug: longSlug, visibility: "list" },
      { slug: "gpt-escape\u001b[31m", visibility: "list" },
      { slug: "gpt-line\u2028break", visibility: "list" },
    ] }))).toEqual({ state: "ok", slugs: [] });
  });

  it("uses final direct model fields and deduplicates retained slugs", () => {
    const input = JSON.stringify({ models: [
      { slug: "first", visibility: "list", nested: { slug: "nested", visibility: "list" } },
      { slug: "first", visibility: "list" },
      { slug: "cleared", visibility: "list" },
    ] }).replace('"slug":"cleared"', '"slug":"cleared","slug":false');
    expect(parseText(input)).toEqual({ state: "ok", slugs: ["first"] });
  });
});
