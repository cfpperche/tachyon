/**
 * 515 fatia 1 — a segunda porta de entrada de um plugin.
 *
 * O que vale testar aqui é o que a porta NOVA decide: onde o manifesto pode estar dentro do arquivo,
 * o que ela recusa pelo nome, e o fato que sustenta o desenho inteiro — que um plugin lido de um zip
 * não carrega procedência, e que o resto do sistema já aceita isso.
 *
 * O que NÃO se testa aqui, de propósito: preview, consentimento e apply. Eles não sabem de onde o
 * plugin veio — operam sobre um `LoadedPlugin` —, e duplicar a cobertura deles nesta porta afirmaria
 * um acoplamento que a spec existe para não criar.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginFromZipFile } from "../../apps/vscode-extension/src/plugins/zipSource.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-zipsrc-"));
  made.push(dir);
  return dir;
}

const MANIFEST = {
  name: "demo",
  version: "1.0.0",
  description: "a plugin that ships one skill",
  runtimes: ["claude"],
};

/** Build a zip whose files sit at `prefix` (empty for the root). */
async function zipWith(files: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const out = path.join(temp(), "plugin.zip");
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}

const SKILL = "---\nname: demo\ndescription: demo skill\n---\nbody\n";

describe("loading a plugin from a zip", () => {
  it("reads a plugin whose manifest sits at the root", async () => {
    const zip = await zipWith({
      "tachyon-plugin.json": JSON.stringify(MANIFEST),
      "skills/demo/SKILL.md": SKILL,
    });
    const loaded = await loadPluginFromZipFile(zip);
    if (loaded.stagingDir) made.push(loaded.stagingDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.plugin?.manifest.name).toBe("demo");
  });

  it("reads one whose files sit inside a single folder — which is what a release download produces", async () => {
    const zip = await zipWith({
      "demo-1.0.0/tachyon-plugin.json": JSON.stringify(MANIFEST),
      "demo-1.0.0/skills/demo/SKILL.md": SKILL,
    });
    const loaded = await loadPluginFromZipFile(zip);
    if (loaded.stagingDir) made.push(loaded.stagingDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.plugin?.manifest.name).toBe("demo");
  });

  it("carries NO provenance, because a file the human chose has none to prove", async () => {
    // This is the whole reason the door is cheap. `LoadResult.provenance` is optional and the lockfile
    // takes `source`/`integrity` as optional too, so nothing downstream needed a schema change. A
    // synthetic `source: { type: "zip" }` would record that a file existed somewhere once.
    const zip = await zipWith({
      "tachyon-plugin.json": JSON.stringify(MANIFEST),
      "skills/demo/SKILL.md": SKILL,
    });
    const loaded = await loadPluginFromZipFile(zip);
    if (loaded.stagingDir) made.push(loaded.stagingDir);
    expect(loaded.provenance).toBeUndefined();
  });

  it("refuses an archive with no manifest, and says where it looked", async () => {
    const zip = await zipWith({ "readme.md": "# not a plugin" });
    const loaded = await loadPluginFromZipFile(zip);
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.errors.join(" ")).toMatch(/no tachyon-plugin\.json .* inside a single folder/);
  });

  it("refuses an archive carrying two plugins instead of guessing which one was meant", async () => {
    const zip = await zipWith({
      "one/tachyon-plugin.json": JSON.stringify({ ...MANIFEST, name: "one" }),
      "one/skills/demo/SKILL.md": SKILL,
      "two/tachyon-plugin.json": JSON.stringify({ ...MANIFEST, name: "two" }),
      "two/skills/demo/SKILL.md": SKILL,
    });
    const loaded = await loadPluginFromZipFile(zip);
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.errors.join(" ")).toMatch(/carries 2 plugins/);
  });

  it("passes a bad manifest's own errors through, rather than replacing them with 'invalid zip'", async () => {
    // The author needs the field name, not the container. The zip door adds no vocabulary of its own.
    const zip = await zipWith({ "tachyon-plugin.json": JSON.stringify({ name: "Demo", version: "1.0.0" }) });
    const loaded = await loadPluginFromZipFile(zip);
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.errors.some((e) => /name|description/.test(e))).toBe(true);
  });

  it("leaves nothing behind when it refuses", async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("tachyon-plugin-zip-")).length;
    await loadPluginFromZipFile(await zipWith({ "readme.md": "# nope" }));
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("tachyon-plugin-zip-")).length;
    expect(after).toBe(before);
  });

  it("refuses a file that is not a zip at all, naming the file", async () => {
    const notZip = path.join(temp(), "plugin.zip");
    fs.writeFileSync(notZip, "this is not an archive");
    const loaded = await loadPluginFromZipFile(notZip);
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.errors.join(" ")).toContain("plugin.zip");
  });
});
