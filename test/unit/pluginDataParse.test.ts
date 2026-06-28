import { describe, it, expect } from "vitest";
import { loadManifest } from "../../src/plugins/manifest.js";

// spec 284 — `data` artifact declaration parsing (the non-executable sibling of `tools`).

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);
const URL = "https://example.com/model/ggml-base.bin";

function withData(data: unknown): ReturnType<typeof loadManifest> {
  return loadManifest(JSON.stringify({
    name: "transcribe",
    version: "1.0.0",
    description: "speech to text",
    runtimes: ["claude"],
    blocks: { claude: "claude/" },
    data,
  }));
}

describe("loadManifest — data artifacts (spec 284)", () => {
  it("accepts a single cross-platform data artifact", () => {
    const { manifest, errors } = withData({ model: { version: "base", url: URL, sha256: SHA } });
    expect(errors).toEqual([]);
    expect(manifest?.data.model.version).toBe("base");
    expect(manifest?.data.model.single).toEqual({ url: URL, sha256: SHA });
    expect(manifest?.data.model.platforms).toBeUndefined();
  });

  it("accepts an optional fileName", () => {
    const { manifest, errors } = withData({ model: { version: "base", url: URL, sha256: SHA, fileName: "ggml-base.bin" } });
    expect(errors).toEqual([]);
    expect(manifest?.data.model.fileName).toBe("ggml-base.bin");
  });

  it("accepts a per-platform data artifact", () => {
    const { manifest, errors } = withData({
      model: { version: "base", platforms: { "linux-x64-glibc": { url: URL, sha256: SHA }, "darwin-arm64": { url: URL, sha256: SHA2 } } },
    });
    expect(errors).toEqual([]);
    expect(manifest?.data.model.single).toBeUndefined();
    expect(manifest?.data.model.platforms?.["linux-x64-glibc"]).toEqual({ url: URL, sha256: SHA });
    expect(manifest?.data.model.platforms?.["darwin-arm64"]).toEqual({ url: URL, sha256: SHA2 });
  });

  it("defaults to empty when `data` is omitted", () => {
    const { manifest, errors } = loadManifest(JSON.stringify({
      name: "x", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" },
    }));
    expect(errors).toEqual([]);
    expect(manifest?.data).toEqual({});
  });

  it("REJECTS an archive data artifact (single-file v1)", () => {
    const { manifest, errors } = withData({ model: { version: "base", url: URL, sha256: SHA, archive: { type: "tar.gz", innerPath: "m.bin", binSha256: SHA } } });
    expect(manifest).toBeUndefined();
    expect(errors.some((e) => /archive data artifacts are not supported/.test(e))).toBe(true);
  });

  it("REJECTS declaring both a single artifact and platforms", () => {
    const { errors } = withData({ model: { version: "base", url: URL, sha256: SHA, platforms: { "linux-x64-glibc": { url: URL, sha256: SHA } } } });
    expect(errors.some((e) => /EITHER a single .* OR .* platforms/.test(e))).toBe(true);
  });

  it("REJECTS declaring neither a single artifact nor platforms", () => {
    const { errors } = withData({ model: { version: "base" } });
    expect(errors.some((e) => /must declare a single .* or a per-platform/.test(e))).toBe(true);
  });

  it("REJECTS a non-kebab data name", () => {
    const { errors } = withData({ Model_X: { version: "base", url: URL, sha256: SHA } });
    expect(errors.some((e) => /not a valid data name/.test(e))).toBe(true);
  });

  it("REJECTS a non-https url and a malformed sha256", () => {
    const bad = withData({ model: { version: "base", url: "http://example.com/m.bin", sha256: "nope" } });
    expect(bad.errors.some((e) => /url/.test(e))).toBe(true);
    expect(bad.errors.some((e) => /sha256/.test(e))).toBe(true);
  });

  it("REJECTS an unknown field + an unknown platform key", () => {
    expect(withData({ model: { version: "base", url: URL, sha256: SHA, bogus: 1 } }).errors.some((e) => /unknown field 'bogus'/.test(e))).toBe(true);
    expect(withData({ model: { version: "base", platforms: { "windows-x64": { url: URL, sha256: SHA } } } }).errors.some((e) => /not a known platform key/.test(e))).toBe(true);
  });

  it("REJECTS a fileName with path separators", () => {
    expect(withData({ model: { version: "base", url: URL, sha256: SHA, fileName: "sub/dir.bin" } }).errors.some((e) => /single path segment/.test(e))).toBe(true);
  });
});
