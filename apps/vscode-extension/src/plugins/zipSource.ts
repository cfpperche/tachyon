/**
 * 515 — the second door a plugin can arrive through: a `.zip` the human picked on their own disk.
 *
 * ## Why this is small
 *
 * `loadPluginFromSource` does three things in a row: resolve an address, fetch the payload, and call
 * `loadPlugin(dir)`. Only the first two are about git. Everything downstream of the load — the
 * install preview, the consent drawer, the apply transaction — operates on a `LoadedPlugin`, never on
 * a source. So a second door is a different way to produce a directory, and nothing else.
 *
 * ## What it deliberately does NOT produce
 *
 * A provenance. `LoadResult.provenance` is documented as "present only when loaded via a source-spec",
 * and in the lockfile `source` and `integrity` are already optional — so a zip install records without
 * either, and the rest of the system already tolerates that.
 *
 * That absence is the honest answer, not a gap to fill later. A checksum of a file the human chose on
 * their own machine proves nothing: there is no publisher to bind it to and no second party who could
 * ever re-verify it. Recording a synthetic `source: { type: "zip" }` would be recording the fact that
 * a file existed somewhere once.
 *
 * What does NOT go away is consent to EXECUTE. A zip that provisions a binary or installs a git hook
 * still passes through the same acknowledgement as one fetched from git, because the consequence is
 * identical: third-party code runs on this machine. Local origin excuses proving where it came from;
 * it never excuses knowing what it does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractZipContained } from "@tachyon/engine/files/extractZip.js";
import { loadPlugin, type LoadResult } from "./engine.js";

/**
 * Unpack `zipPath` and load the plugin it carries.
 *
 * The staging directory is the caller's to keep: `loadPlugin` returns a `LoadedPlugin` whose `dir`
 * points into it, and the install reads the payload from there. It lives under the OS temp dir and is
 * removed on any failure — a half-unpacked archive must never look like a plugin.
 */
export async function loadPluginFromZipFile(zipPath: string): Promise<LoadResult & { stagingDir?: string }> {
  let staging: string;
  try {
    staging = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-plugin-zip-"));
  } catch (error) {
    return { errors: [`could not create a staging directory: ${message(error)}`] };
  }
  try {
    await extractZipContained(zipPath, staging, "plugin");
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { errors: [`could not read '${path.basename(zipPath)}': ${message(error)}`] };
  }
  // An archive whose files sit under one folder is what every "download this release" produces, so
  // accept it: if the root has no manifest and exactly one directory does, that directory IS the
  // plugin. More than one candidate is ambiguous and refused by name rather than guessed at.
  const root = resolvePayloadRoot(staging);
  if (!root.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { errors: [root.error] };
  }
  const loaded = loadPlugin(root.dir);
  if (!loaded.plugin) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { errors: loaded.errors };
  }
  return { plugin: loaded.plugin, errors: [], stagingDir: staging };
}

const MANIFEST = "tachyon-plugin.json";

function resolvePayloadRoot(staging: string): { ok: true; dir: string } | { ok: false; error: string } {
  if (fs.existsSync(path.join(staging, MANIFEST))) return { ok: true, dir: staging };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(staging, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: `could not read the unpacked archive: ${message(error)}` };
  }
  const nested = entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(staging, entry.name, MANIFEST)))
    .map((entry) => entry.name);
  if (nested.length === 1) return { ok: true, dir: path.join(staging, nested[0]!) };
  if (nested.length > 1) {
    return { ok: false, error: `the archive carries ${nested.length} plugins (${nested.join(", ")}); it must carry exactly one` };
  }
  return { ok: false, error: `no ${MANIFEST} in the archive — a plugin zip carries it at the root, or inside a single folder` };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
