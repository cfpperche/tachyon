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
  const record = { version, ...gitMeta(), dist: distHashes() };
  fs.writeFileSync(EMBEDDED_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`wrote ${rel(EMBEDDED_PATH)}`);
}

function writeAudit() {
  const verify = runVerify();
  const vsixPath = findVsix();
  const record = {
    version,
    ...gitMeta(),
    packagedBy: process.env.TACHYON_AGENT_NAME || process.env.USER || os.userInfo().username,
    vsix: { path: vsixPath ? rel(vsixPath) : "", sha256: vsixPath ? sha256(vsixPath) : null },
    dist: distHashes(),
    verify,
    note: "Dogfood build provenance only: detects accidental or lazy out-of-band installs. This is not a security boundary; local agents can forge the record.",
  };
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const out = path.join(AUDIT_DIR, `${version}.json`);
  fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  console.log(`wrote ${rel(out)}`);
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
 */
const mode = process.argv[2];
if (mode === "embed") writeEmbedded();
else if (mode === "audit") writeAudit();
else {
  writeEmbedded();
  writeAudit();
}
