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

if (!version || typeof version !== "string") throw new Error("package.json version is required");
const distDir = path.join(root, "dist");
if (!fs.existsSync(distDir)) throw new Error("dist/ does not exist; build before recording provenance");

const verify = runVerify();
const vsixPath = findVsix();
const dist = Object.fromEntries(walkFiles(distDir).map((file) => [rel(file), sha256(file)]));
const record = {
  version,
  ...gitMeta(),
  packagedBy: process.env.TACHYON_AGENT_NAME || process.env.USER || os.userInfo().username,
  vsix: { path: vsixPath ? rel(vsixPath) : "", sha256: vsixPath ? sha256(vsixPath) : null },
  dist,
  verify,
  note: "Dogfood build provenance only: detects accidental or lazy out-of-band installs. This is not a security boundary; local agents can forge the record.",
};

const outDir = path.join(root, ".tachyon", "deploys");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${version}.json`);
fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(`wrote ${rel(out)}`);
if (verify.result !== "passed" && !verify.result.startsWith("skipped ")) process.exitCode = 1;
