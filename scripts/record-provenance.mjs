import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function gitMeta() {
  try {
    const commit = git(["rev-parse", "HEAD"]);
    const treeSha = git(["rev-parse", "HEAD^{tree}"]);
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
    return { commit, treeSha, workingTreeClean: !dirty };
  } catch {
    return { commit: null, treeSha: null, workingTreeClean: false };
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walkFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...walkFiles(abs));
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function findVsix() {
  const arg = process.argv.find((a) => a.endsWith(".vsix"));
  if (arg) return path.resolve(root, arg);
  const expected = path.join(root, `${pkg.name}-${version}.vsix`);
  if (fs.existsSync(expected)) return expected;
  const matches = fs.readdirSync(root).filter((f) => f.endsWith(".vsix")).sort();
  return matches.length === 1 ? path.join(root, matches[0]) : null;
}

function runVerify() {
  const command = "npm run verify:full";
  if (process.env.TACHYON_SKIP_PROVENANCE_VERIFY === "1") return { command, result: "skipped by TACHYON_SKIP_PROVENANCE_VERIFY=1" };
  try {
    execFileSync("npm", ["run", "verify:full"], { cwd: root, stdio: "inherit" });
    return { command, result: "passed" };
  } catch (err) {
    return { command, result: `failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function distHashes() {
  const distDir = path.join(root, "dist");
  if (!fs.existsSync(distDir)) throw new Error("dist/ does not exist; build before recording provenance");
  return Object.fromEntries(walkFiles(distDir).map((file) => [rel(file), sha256(file)]));
}

function engineChannel() {
  const manifestPath = path.join(root, "dist", "engine", "engine-manifest.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.channel === "stable" || manifest.channel === "dev" ? manifest.channel : null;
  } catch {
    return null;
  }
}

/**
 * Packaged identity for the audit trail: version/channel/git/dist of the shipped artifact.
 * Prefer the VSIX's embedded provenance.json (written at embed time, packed by vsce) so a later
 * verify:full rebuild of workspace dist as `dev` cannot rewrite the human deploy record.
 */
function parsePackagedIdentity(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "string") return null;
    if (!(parsed.dist && typeof parsed.dist === "object" && !Array.isArray(parsed.dist))) return null;
    const channel = parsed.engineChannel;
    if (!(channel === undefined || channel === null || channel === "stable" || channel === "dev")) return null;
    return {
      version: parsed.version,
      engineChannel: channel === undefined ? null : channel,
      commit: typeof parsed.commit === "string" || parsed.commit === null ? parsed.commit : null,
      treeSha: typeof parsed.treeSha === "string" || parsed.treeSha === null ? parsed.treeSha : null,
      workingTreeClean: typeof parsed.workingTreeClean === "boolean" ? parsed.workingTreeClean : false,
      dist: Object.fromEntries(
        Object.entries(parsed.dist).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"),
      ),
    };
  } catch {
    return null;
  }
}

function readVsixPackagedIdentity(vsixPath) {
  try {
    const raw = execFileSync("unzip", ["-p", vsixPath, "extension/provenance.json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parsePackagedIdentity(raw);
  } catch {
    return null;
  }
}

/** Snapshot workspace dist/channel/git before verify:full mutates the tree (default rebuild is dev). */
function snapshotWorkspacePackageIdentity() {
  return {
    version,
    engineChannel: engineChannel(),
    ...gitMeta(),
    dist: distHashes(),
  };
}

function resolvePackagedIdentity(vsixPath) {
  if (vsixPath) {
    const fromVsix = readVsixPackagedIdentity(vsixPath);
    if (fromVsix) return { source: "vsix", identity: fromVsix };
  }
  return { source: "workspace-pre-verify", identity: snapshotWorkspacePackageIdentity() };
}

if (!version || typeof version !== "string") throw new Error("package.json version is required");

// EMBEDDED path: the extension root (NOT dist/, so this file never has to hash itself), packed
// into the vsix by vsce (see .vscodeignore's `!provenance.json`). This is what activation reads —
// a fact about the installed extension, not any workspace — so it deliberately excludes the vsix's
// own sha256 (chicken-and-egg: the vsix doesn't exist yet when this file must already be inside it).
const EMBEDDED_PATH = path.join(root, "provenance.json");
// AUDIT path: the human trail, unchanged in shape, additionally carrying the packaged vsix's own
// sha256 and the verify:full result — for a human to cross-check after `vsce package`.
const AUDIT_DIR = path.join(root, ".tachyon", "deploys");

function writeEmbedded() {
  const record = { version, engineChannel: engineChannel(), ...gitMeta(), dist: distHashes() };
  fs.writeFileSync(EMBEDDED_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`wrote ${rel(EMBEDDED_PATH)}`);
}

function writeAudit() {
  // Capture packaged facts BEFORE runVerify: verify:full runs `node esbuild.mjs` which rebuilds
  // dist on the default `dev` channel and would otherwise poison engineChannel + dist hashes.
  const vsixPath = findVsix();
  const { source, identity } = resolvePackagedIdentity(vsixPath);
  const verify = runVerify();
  const record = {
    version: identity.version,
    engineChannel: identity.engineChannel,
    commit: identity.commit,
    treeSha: identity.treeSha,
    workingTreeClean: identity.workingTreeClean,
    packagedBy: process.env.TACHYON_AGENT_NAME || process.env.USER || os.userInfo().username,
    vsix: { path: vsixPath ? rel(vsixPath) : "", sha256: vsixPath ? sha256(vsixPath) : null },
    dist: identity.dist,
    verify,
    // engineChannel/dist are frozen from the VSIX (or a pre-verify workspace snapshot). verify:full
    // rebuilds workspace dist as `dev` and must not rewrite the packaged identity in this record.
    note: "Dogfood build provenance only: detects accidental or lazy out-of-band installs. This is not a security boundary; local agents can forge the record.",
  };
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const out = path.join(AUDIT_DIR, `${identity.version}.json`);
  fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`wrote ${rel(out)} (package identity from ${source})`);
  if (verify.result !== "passed" && !verify.result.startsWith("skipped ")) process.exitCode = 1;
}

/**
 * Deploy ritual (ORDER MATTERS): bump version -> node esbuild.mjs
 *   -> node scripts/record-provenance.mjs embed   (dist/ exists now; vsix does not yet)
 *   -> vsce package                                (packs provenance.json into the vsix)
 *   -> node scripts/record-provenance.mjs audit [the-built.vsix]  (vsix exists now; hash it)
 *   -> install -> verify hashes -> reload
 *
 * Two phases because the embedded record must be written before the vsix exists (to be packed
 * into it) and the audit record's vsix sha256 can only be computed after it exists. Called with
 * no mode (or an unrecognized one), both phases run back-to-back for local convenience — but then
 * the audit record's vsix sha256 reflects whatever .vsix (if any) is already on disk, not the one
 * this run is about to produce; the real ritual invokes the two phases separately around `vsce package`.
 *
 * Audit deliberately freezes package identity before verify:full (or reads it from the VSIX) so the
 * post-verify workspace dist rebuild cannot re-label a stable package as dev in .tachyon/deploys/.
 */
const mode = process.argv[2];
if (mode === "embed") writeEmbedded();
else if (mode === "audit") writeAudit();
else {
  writeEmbedded();
  writeAudit();
}
