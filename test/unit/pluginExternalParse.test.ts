import { describe, it, expect } from "vitest";
import { loadManifest } from "@tachyon/engine/plugins/manifest.js";

// spec 285 — externalTools declaration parsing (declare + detect + per-PM assisted-install argv).

function withExternal(externalTools: unknown): ReturnType<typeof loadManifest> {
  return loadManifest(JSON.stringify({
    name: "transcribe", version: "1.0.0", description: "stt", runtimes: ["claude"], blocks: { claude: "claude/" },
    externalTools,
  }));
}

describe("loadManifest — externalTools (spec 285)", () => {
  it("accepts a well-formed external tool", () => {
    const { manifest, errors } = withExternal({
      "whisper-cli": { detect: ["whisper-cli", "--help"], install: { brew: { argv: ["brew", "install", "whisper-cpp"] }, apt: { argv: ["sudo", "apt-get", "install", "-y", "whisper-cpp"] } }, manual: "https://example.com/whisper" },
    });
    expect(errors).toEqual([]);
    expect(manifest?.externalTools["whisper-cli"].detect).toEqual(["whisper-cli", "--help"]);
    expect(manifest?.externalTools["whisper-cli"].install.apt?.argv).toEqual(["sudo", "apt-get", "install", "-y", "whisper-cpp"]);
    expect(manifest?.externalTools["whisper-cli"].manual).toBe("https://example.com/whisper");
  });

  it("defaults to empty when omitted", () => {
    const { manifest, errors } = loadManifest(JSON.stringify({ name: "x", version: "1.0.0", description: "d", runtimes: ["claude"], blocks: { claude: "claude/" } }));
    expect(errors).toEqual([]);
    expect(manifest?.externalTools).toEqual({});
  });

  it("REJECTS an install command given as a shell string (must be argv)", () => {
    const { manifest, errors } = withExternal({ ffmpeg: { install: { apt: "sudo apt-get install -y ffmpeg" }, manual: "get ffmpeg" } });
    expect(manifest).toBeUndefined();
    expect(errors.some((e) => /structured argv, NEVER a shell string/.test(e))).toBe(true);
  });

  it("REJECTS an unknown package manager", () => {
    expect(withExternal({ ffmpeg: { install: { winget: { argv: ["winget", "install", "ffmpeg"] } }, manual: "x" } }).errors.some((e) => /not a known package manager/.test(e))).toBe(true);
  });

  it("REJECTS an empty install map and a missing manual", () => {
    expect(withExternal({ ffmpeg: { install: {}, manual: "x" } }).errors.some((e) => /at least one package manager/.test(e))).toBe(true);
    expect(withExternal({ ffmpeg: { install: { apt: { argv: ["apt-get", "install", "ffmpeg"] } } } }).errors.some((e) => /manual: required/.test(e))).toBe(true);
  });

  it("REJECTS control chars in an install argv + a non-kebab tool name", () => {
    expect(withExternal({ ffmpeg: { install: { apt: { argv: ["apt-get", "in\u0000stall"] } }, manual: "x" } }).errors.length).toBeGreaterThan(0);
    expect(withExternal({ FFmpeg: { install: { apt: { argv: ["apt-get", "install", "ffmpeg"] } }, manual: "x" } }).errors.some((e) => /not a valid tool name/.test(e))).toBe(true);
  });

  // spec 289 — candidate binary names
  it("accepts a candidate `names` list + dedupes preserving order", () => {
    const { manifest, errors } = withExternal({
      chrome: { names: ["google-chrome", "chromium", "google-chrome"], install: { apt: { argv: ["sudo", "apt-get", "install", "-y", "chromium"] } }, manual: "install a browser" },
    });
    expect(errors).toEqual([]);
    expect(manifest?.externalTools.chrome.names).toEqual(["google-chrome", "chromium"]);
  });

  it("treats an empty `names` array as omitted (no field)", () => {
    const { manifest, errors } = withExternal({ chrome: { names: [], install: { apt: { argv: ["sudo", "apt-get", "install", "-y", "chromium"] } }, manual: "x" } });
    expect(errors).toEqual([]);
    expect(manifest?.externalTools.chrome.names).toBeUndefined();
  });

  it("REJECTS a name with a path separator, and a list over the cap of 8", () => {
    expect(withExternal({ chrome: { names: ["/usr/bin/chrome"], install: { apt: { argv: ["sudo", "apt-get", "install", "-y", "chromium"] } }, manual: "x" } }).errors.length).toBeGreaterThan(0);
    const tooMany = Array.from({ length: 9 }, (_, i) => `c${i}`);
    expect(withExternal({ chrome: { names: tooMany, install: { apt: { argv: ["sudo", "apt-get", "install", "-y", "chromium"] } }, manual: "x" } }).errors.some((e) => /at most 8/.test(e))).toBe(true);
  });
});
