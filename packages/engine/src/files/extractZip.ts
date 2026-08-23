/**
 * 515 — unpack a zip into a directory, with every entry kept inside it.
 *
 * Written for apps (spec 514) and now shared with plugins, because "the human picked an archive on
 * their own disk" is one story and deserves one implementation.
 *
 * The containment check is HYGIENE, not a security barrier, and the distinction matters enough to say
 * twice: what the human installs — an app, a plugin — is trusted by the act of installing it. What
 * this prevents is a malformed or careless archive scattering files across the workspace, which is a
 * correctness problem, not an attack. Anyone who reads this as a sandbox will build the next feature
 * on a guarantee it does not make.
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { contained } from "./contained.js";

/**
 * Extract `zipPath` into `destination`.
 *
 * `label` names the thing being unpacked ("app", "plugin") so a refusal reads as a sentence about
 * what the human was doing rather than about this function.
 */
export async function extractZipContained(zipPath: string, destination: string, label: string): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  for (const entry of Object.values(zip.files)) {
    // `unsafeOriginalName` is the path as the archive wrote it; JSZip's `name` is already normalized,
    // and normalizing before checking is how a `../` slips through a containment test.
    const archivePath = entry.unsafeOriginalName ?? entry.name;
    const target = contained(destination, archivePath);
    if (!target) throw new Error(`zip entry path is outside the ${label} directory: ${archivePath}`);
    if (entry.dir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async("nodebuffer"));
  }
}
