/**
 * 515 — an app package must not be offered where plugins install.
 *
 * The owner hit this with a real file: `hello-fleet.zip`, an APP he had built, sitting at the top of
 * the plugin installer's suggestions because the scan matched on `.zip` and nothing else. A picker that
 * suggests the wrong thing is worse than one that suggests nothing — it reads as a recommendation.
 *
 * Telling them apart needs the names inside the archive, and a zip already stores those in plaintext in
 * its central directory. So the check reads the tail of the file rather than the file, and the tests
 * below pin both halves: that the reader gets the names out of real archives, and that an answer it
 * could NOT measure stays `undefined` instead of collapsing into "not a plugin".
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { classifyZipPayload, listZipEntryNames, zipPayloadKind } from "@tachyon/engine/files/zipEntries.js";
import { findZipCandidates } from "@tachyon/engine/files/zipPicker.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-zipkind-"));
  made.push(dir);
  return dir;
}

async function writeZip(dir: string, name: string, files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [entry, content] of Object.entries(files)) zip.file(entry, content);
  const out = path.join(dir, name);
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}

const PLUGIN = { "tachyon-plugin.json": "{}", "skills/demo/SKILL.md": "x" };
const APP = { "app.json": "{}", "index.html": "<p>hi</p>" };

describe("reading what is inside an archive without unpacking it", () => {
  it("lists the entry names of a real zip", async () => {
    const zip = await writeZip(temp(), "p.zip", PLUGIN);
    expect(listZipEntryNames(zip)).toEqual(expect.arrayContaining(["tachyon-plugin.json", "skills/demo/SKILL.md"]));
  });

  it("answers undefined for a file that is not a zip — not an empty list", async () => {
    // The distinction is the point: an empty list would read as "this archive contains nothing",
    // which downstream turns into "this is not a plugin". It was never measured.
    const dir = temp();
    const bogus = path.join(dir, "not.zip");
    fs.writeFileSync(bogus, "definitely not an archive");
    expect(listZipEntryNames(bogus)).toBeUndefined();
  });

  it("answers undefined for a truncated archive", async () => {
    const dir = temp();
    const zip = await writeZip(dir, "cut.zip", PLUGIN);
    const bytes = fs.readFileSync(zip);
    fs.writeFileSync(zip, bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect(listZipEntryNames(zip)).toBeUndefined();
  });

  it("answers undefined for a file that does not exist", () => {
    expect(listZipEntryNames(path.join(temp(), "absent.zip"))).toBeUndefined();
  });
});

describe("classifying a Tachyon archive", () => {
  it("knows a plugin from an app", () => {
    expect(classifyZipPayload(["tachyon-plugin.json", "skills/demo/SKILL.md"])).toBe("plugin");
    expect(classifyZipPayload(["app.json", "index.html"])).toBe("app");
  });

  it("accepts the release shape, where everything sits under one folder", () => {
    expect(classifyZipPayload(["sdd-1.9.0/tachyon-plugin.json", "sdd-1.9.0/skills/sdd/SKILL.md"])).toBe("plugin");
    expect(classifyZipPayload(["hello-fleet/app.json", "hello-fleet/index.html"])).toBe("app");
  });

  it("does not read a manifest buried three levels down as the archive's identity", () => {
    expect(classifyZipPayload(["bundle/vendor/thing/tachyon-plugin.json"])).toBeUndefined();
  });

  it("refuses to guess when an archive carries both manifests", () => {
    expect(classifyZipPayload(["tachyon-plugin.json", "app.json"])).toBeUndefined();
  });

  it("does not mistake a longer filename for the manifest", () => {
    expect(classifyZipPayload(["my-tachyon-plugin.json"])).toBeUndefined();
    expect(classifyZipPayload(["backup-app.json"])).toBeUndefined();
  });

  it("reads a real file end to end, which is what the scan actually calls", async () => {
    const dir = temp();
    expect(zipPayloadKind(await writeZip(dir, "p.zip", PLUGIN))).toBe("plugin");
    expect(zipPayloadKind(await writeZip(dir, "a.zip", APP))).toBe("app");
    expect(zipPayloadKind(path.join(dir, "absent.zip"))).toBeUndefined();
  });
});

describe("the picker only suggests what the door installs", () => {
  it("keeps plugins and drops the app package the owner actually hit", async () => {
    const dir = temp();
    await writeZip(dir, "sdd-1.9.0.zip", PLUGIN);
    await writeZip(dir, "hello-fleet.zip", APP);

    expect(findZipCandidates([dir], undefined, undefined, "plugin").map((c) => c.name)).toEqual(["sdd-1.9.0.zip"]);
    expect(findZipCandidates([dir], undefined, undefined, "app").map((c) => c.name)).toEqual(["hello-fleet.zip"]);
  });

  it("keeps an archive it could not measure, rather than hiding it", async () => {
    // A refusal to read is not evidence about the contents. Dropping it here would silently hide a
    // real plugin whose archive happened to be unusual, and the human would have no way to know why.
    const dir = temp();
    await writeZip(dir, "good.zip", PLUGIN);
    fs.writeFileSync(path.join(dir, "unreadable.zip"), "not an archive");

    const names = findZipCandidates([dir], undefined, undefined, "plugin").map((c) => c.name);
    expect(names).toContain("unreadable.zip");
    expect(names).toContain("good.zip");
  });

  it("without a wanted kind, offers everything — the scan itself did not change", async () => {
    const dir = temp();
    await writeZip(dir, "a.zip", PLUGIN);
    await writeZip(dir, "b.zip", APP);
    expect(findZipCandidates([dir]).length).toBe(2);
  });
});
