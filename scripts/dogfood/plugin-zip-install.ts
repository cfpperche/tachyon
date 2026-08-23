/**
 * 515 — dogfood da fatia 1: um plugin real, empacotado e lido pela porta nova.
 *
 * Não instala nada no workspace: prova a PORTA. O que a instalação faz depois já é coberto pelo
 * caminho de git, que não mudou — e é exatamente esse o desenho que a spec defende.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { loadPluginFromZipFile } from "../../apps/vscode-extension/src/plugins/zipSource.js";

const source = path.resolve(".tachyon/plugins/sdd");
if (!fs.existsSync(path.join(source, "tachyon-plugin.json"))) {
  console.error(`dogfood needs an installed plugin to package; ${source} is not one`);
  process.exit(1);
}

const zip = new JSZip();
const walk = (dir: string, prefix: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, rel);
    else if (entry.isFile()) zip.file(rel, fs.readFileSync(full));
  }
};
// Packaged under a folder on purpose: that is the shape a "download this release" zip has, and the
// shape the loader has to accept without the human flattening it first.
walk(source, "sdd-1.9.0");

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-dogfood-")), "sdd.zip");
fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));

const loaded = await loadPluginFromZipFile(out);
if (!loaded.plugin) {
  console.error("FAILED to load the packaged plugin:", loaded.errors.join("; "));
  process.exit(1);
}
if (loaded.provenance !== undefined) {
  console.error("FAILED: a zip install must carry no provenance");
  process.exit(1);
}
console.log(`ok — ${loaded.plugin.manifest.name} ${loaded.plugin.manifest.version} loaded from a zip, with no provenance`);
console.log(`     skills: ${loaded.plugin.skills.map((s) => s.name).join(", ") || "(none)"}`);
if (loaded.stagingDir) fs.rmSync(loaded.stagingDir, { recursive: true, force: true });
fs.rmSync(path.dirname(out), { recursive: true, force: true });
